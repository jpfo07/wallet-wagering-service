import { addMilliseconds } from "../shared/backoff-policy.ts";
import type { ExponentialBackoff } from "../shared/backoff-policy.ts";
import { InvalidOperationError } from "../shared/domain-error.ts";
import { FailureCode } from "../shared/failure-code.ts";
import type { RejectionCode } from "../shared/failure-code.ts";
import { LedgerDirection } from "../wallet/ledger-direction.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry.ts";
import type { ReferenceState } from "./reference-state.ts";
import { WagerTransactionKind } from "./wager-transaction-kind.ts";
import { WagerTransactionStatus } from "./wager-transaction-status.ts";
import type { WagerTransaction } from "./wager-transaction.ts";

export interface ReferenceRetryPolicy {
  readonly backoff: ExponentialBackoff;
  readonly ttlMs: number;
  readonly random: () => number;
}

export interface SettleWagerInput {
  /** PENDING (first time) or PENDING_REFERENCE (re-check by the worker). */
  readonly transaction: WagerTransaction;
  /** Loaded under the wallet lock. */
  readonly wallet: Wallet;
  /** Required exactly when the transaction informs a reference; notFound() when it is missing. */
  readonly reference: ReferenceState | undefined;
  readonly ledgerEntryId: string;
  readonly at: Date;
  readonly referenceRetry: ReferenceRetryPolicy;
}

export type SettlementOutcome =
  | {
      readonly status: WagerTransactionStatus.Processed;
      readonly ledgerEntry: WalletLedgerEntry | undefined;
    }
  | { readonly status: WagerTransactionStatus.Rejected; readonly failureCode: RejectionCode }
  | { readonly status: WagerTransactionStatus.PendingReference };

/**
 * Applies the business rules of a wager transaction to its wallet, in memory. Checks run in a fixed
 * order and the first failure wins, so the provider always gets the same failureCode for the same
 * situation. A rejection never touches the wallet. Both the use case (first time) and the
 * PENDING_REFERENCE worker (re-check) call this, so each rule lives in one place.
 */
export function settleWager(input: SettleWagerInput): SettlementOutcome {
  const { transaction, wallet, reference, at } = input;
  if (
    transaction.status !== WagerTransactionStatus.Pending &&
    transaction.status !== WagerTransactionStatus.PendingReference
  ) {
    throw new InvalidOperationError(
      `transaction ${transaction.id} is ${transaction.status} and cannot be settled`,
    );
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidOperationError(
      `transaction ${transaction.id} belongs to wallet ${transaction.walletId}, not ${wallet.id}`,
    );
  }
  if (transaction.hasReference() !== (reference !== undefined)) {
    throw new InvalidOperationError(
      `transaction ${transaction.id}: reference state must be given exactly when a reference was informed`,
    );
  }

  const reject = (code: RejectionCode, referenceTransactionId?: string): SettlementOutcome => {
    transaction.reject({ code, observedBalance: wallet.balance, referenceTransactionId, at });
    return { status: WagerTransactionStatus.Rejected, failureCode: code };
  };

  // 1–2: the wallet itself.
  if (transaction.playerId !== wallet.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (transaction.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  // 3–8: the reference.
  const referenced = reference?.transaction;
  if (reference !== undefined) {
    if (referenced === undefined) {
      return waitForReference(input, () => reject(FailureCode.ReferenceNotFound));
    }
    if (!sameContext(transaction, referenced)) {
      return reject(FailureCode.ReferenceMismatch, referenced.id);
    }
    if (!transaction.allowedReferenceKinds().includes(referenced.kind)) {
      return reject(FailureCode.ReferenceKindNotAllowed, referenced.id);
    }
    if (
      referenced.status === WagerTransactionStatus.Pending ||
      referenced.status === WagerTransactionStatus.PendingReference
    ) {
      return waitForReference(input, () =>
        reject(FailureCode.ReferenceNotProcessed, referenced.id),
      );
    }
    if (referenced.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed, referenced.id);
    }
    if (transaction.isReversal()) {
      if (reference.everReversed) {
        return reject(FailureCode.ReferenceAlreadyReversed, referenced.id);
      }
      if (referenced.kind === WagerTransactionKind.Bet && reference.hasActiveWin) {
        return reject(FailureCode.ReferenceHasActiveSettlement, referenced.id);
      }
      if (!transaction.money.equals(referenced.money)) {
        return reject(FailureCode.AmountMismatch, referenced.id);
      }
    } else if (reference.effectivelyReversed) {
      return reject(FailureCode.ReferenceAlreadyReversed, referenced.id);
    }
  }

  // 9: LOSS records the outcome without moving the balance.
  if (!transaction.affectsBalance()) {
    transaction.markProcessed({
      referenceTransactionId: referenced?.id,
      observedBalance: wallet.balance,
      at,
    });
    return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
  }

  // 10: not enough balance. A BET without funds and a reversal that would overdraw are different
  // situations for operations, so they carry different codes.
  const direction = transaction.ledgerDirectionFor(referenced);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    return reject(
      transaction.kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalWouldOverdraw,
      referenced?.id,
    );
  }

  // 11: apply. Balance, version and ledger entry change together inside the wallet.
  const movement = {
    transactionId: transaction.id,
    money: transaction.money,
    ledgerEntryId: input.ledgerEntryId,
    at,
  };
  const ledgerEntry =
    direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  transaction.markProcessed({
    referenceTransactionId: referenced?.id,
    observedBalance: wallet.balance,
    at,
  });
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}

/** Same provider, player, wallet, currency and round. */
function sameContext(transaction: WagerTransaction, referenced: WagerTransaction): boolean {
  return (
    referenced.providerId === transaction.providerId &&
    referenced.playerId === transaction.playerId &&
    referenced.walletId === transaction.walletId &&
    referenced.money.currency === transaction.money.currency &&
    referenced.roundId === transaction.roundId
  );
}

function waitForReference(
  input: SettleWagerInput,
  rejectOnExpiry: () => SettlementOutcome,
): SettlementOutcome {
  const { transaction, wallet, at, referenceRetry } = input;
  const { backoff, ttlMs, random } = referenceRetry;
  if (transaction.status === WagerTransactionStatus.Pending) {
    transaction.markPendingReference({
      observedBalance: wallet.balance,
      nextCheckAt: addMilliseconds(at, backoff.delayFor(0, random)),
      expiresAt: addMilliseconds(at, ttlMs),
      at,
    });
    return { status: WagerTransactionStatus.PendingReference };
  }
  if (transaction.isReferenceExpired(at)) {
    return rejectOnExpiry();
  }
  transaction.scheduleNextReferenceCheck({
    nextCheckAt: addMilliseconds(at, backoff.delayFor(transaction.referenceAttempts + 1, random)),
    at,
  });
  return { status: WagerTransactionStatus.PendingReference };
}
