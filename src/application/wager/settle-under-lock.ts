import type { EventContext, IntegrationEvent } from "../../domain/events/integration-event.ts";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference.ts";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.ts";
import { ReferenceState } from "../../domain/wager/reference-state.ts";
import { settleWager } from "../../domain/wager/wager-settlement.ts";
import type {
  ReferenceRetryPolicy,
  SettlementOutcome,
} from "../../domain/wager/wager-settlement.ts";
import { WagerTransactionStatus } from "../../domain/wager/wager-transaction-status.ts";
import type { WagerTransaction } from "../../domain/wager/wager-transaction.ts";
import type { Wallet } from "../../domain/wallet/wallet.ts";
import type { WagerTransactionRepository } from "../ports/repositories.ts";

export interface SettleUnderLockInput {
  /** PENDING (first time) or PENDING_REFERENCE (re-check by the worker). */
  readonly transaction: WagerTransaction;
  /** Must have been loaded with lockById in the current SQL transaction. */
  readonly wallet: Wallet;
  readonly ledgerEntryId: string;
  readonly at: Date;
  readonly referenceRetry: ReferenceRetryPolicy;
  /** A new context (with a new eventId) per event. */
  readonly eventContext: () => EventContext;
}

export interface SettledUnderLock {
  readonly outcome: SettlementOutcome;
  readonly events: readonly IntegrationEvent<unknown>[];
}

/**
 * The part shared by ProcessWagerTransaction and the PENDING_REFERENCE worker: load what the
 * reference already went through, apply the rules and build the events. Persisting is left to the
 * caller (insert the first time, update on a re-check).
 *
 * Why reading the reference without its own lock is safe: everything that decides the outcome is
 * stable under *this* wallet's lock. PROCESSED dependents of a reference always belong to the same
 * wallet (settleWager requires the same context), so they only change under this lock; a reference
 * from another wallet is refused by immutable fields (walletId, playerId...).
 */
export async function settleUnderLock(
  transactions: WagerTransactionRepository,
  input: SettleUnderLockInput,
): Promise<SettledUnderLock> {
  const { transaction, wallet, at } = input;
  const firstTime = transaction.status === WagerTransactionStatus.Pending;
  const reference = transaction.hasReference()
    ? await loadReferenceState(transactions, transaction)
    : undefined;

  const outcome = settleWager({
    transaction,
    wallet,
    reference,
    ledgerEntryId: input.ledgerEntryId,
    at,
    referenceRetry: input.referenceRetry,
  });

  const events: IntegrationEvent<unknown>[] = [];
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(transaction, input.eventContext()));
      if (outcome.ledgerEntry !== undefined) {
        events.push(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, input.eventContext()));
      }
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, input.eventContext()));
      break;
    case WagerTransactionStatus.PendingReference:
      // Only when it starts waiting; a re-check that keeps waiting is not news.
      if (firstTime) {
        events.push(WagerTransactionPendingReference.from(transaction, input.eventContext()));
      }
      break;
  }
  return { outcome, events };
}

/**
 * The reference by (providerId, referenceExternalTransactionId), its PROCESSED dependents and the
 * PROCESSED ROLLBACKs of those. The computation itself belongs to the domain (ReferenceState).
 */
async function loadReferenceState(
  transactions: WagerTransactionRepository,
  transaction: WagerTransaction,
): Promise<ReferenceState> {
  const referenceExternalId = transaction.referenceExternalTransactionId;
  if (referenceExternalId === undefined) return ReferenceState.notFound();
  const reference = await transactions.findByExternalId(
    transaction.providerId,
    referenceExternalId,
  );
  if (reference === undefined) return ReferenceState.notFound();
  const dependents = await transactions.findProcessedDependents(reference.id);
  const dependentRollbacks =
    dependents.length === 0
      ? []
      : await transactions.findProcessedRollbacksOf(dependents.map((dependent) => dependent.id));
  return ReferenceState.evaluate({ reference, dependents, dependentRollbacks });
}
