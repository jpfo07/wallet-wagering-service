import type { EventContext } from "../../domain/events/integration-event.ts";
import { WagerTransactionFailed } from "../../domain/events/wager-transaction-failed.ts";
import { OutboxMessage } from "../../domain/messaging/outbox-message.ts";
import { DomainError } from "../../domain/shared/domain-error.ts";
import { FailureCode } from "../../domain/shared/failure-code.ts";
import { WagerTransactionStatus } from "../../domain/wager/wager-transaction-status.ts";
import type { WagerTransaction } from "../../domain/wager/wager-transaction.ts";
import type { Wallet } from "../../domain/wallet/wallet.ts";
import { PersistenceIntegrityError } from "../errors.ts";
import type { PendingReferenceCandidate } from "../ports/repositories.ts";
import type { Clock, IdGenerator, RandomSource } from "../ports/system.ts";
import type { ApplicationMetrics, Logger } from "../ports/telemetry.ts";
import type { TransactionScope } from "../ports/unit-of-work.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import type { PendingReferencePolicy } from "./process-wager-transaction.ts";
import { expediteWaitingDependents, settleUnderLock } from "./settle-under-lock.ts";

/** SKIPPED: no longer due or no longer PENDING_REFERENCE when read under the lock. */
export type RecheckOutcome =
  | WagerTransactionStatus.Processed
  | WagerTransactionStatus.Rejected
  | WagerTransactionStatus.PendingReference
  | WagerTransactionStatus.Failed
  | "SKIPPED";

/** What a handled candidate reports: its outcome and, once read under the lock, the transaction. */
interface Checked {
  readonly outcome: RecheckOutcome;
  readonly transaction?: WagerTransaction;
}

interface Locked {
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  readonly at: Date;
}

/**
 * Re-checks PENDING_REFERENCE transactions (section 7.1): the same domain flow as the first
 * time (settleUnderLock), under the same wallet lock.
 *
 * Lock order is the use case's: the candidates are read without any lock, then each one is
 * handled in its own SQL transaction that locks the WALLET first and only then reads the
 * transaction again. Locking the transaction row first and the wallet after would be the reverse
 * order of ProcessWagerTransaction (wallet → transaction rows) and could deadlock with it.
 * Two workers on the same candidate are serialized by the wallet lock; the second one finds it
 * no longer due (rescheduled) or decided, and skips it.
 */
export class RecheckPendingReferences {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly random: RandomSource,
    private readonly pendingReference: PendingReferencePolicy,
    private readonly metrics: ApplicationMetrics,
    private readonly logger: Logger,
  ) {}

  dueCandidates(limit: number): Promise<readonly PendingReferenceCandidate[]> {
    return this.runner.run(
      (scope) => scope.transactions.findDuePendingReferences(this.clock.now(), limit),
      { readOnly: true },
    );
  }

  /**
   * Transient errors (after the runner's retries) propagate: the transaction is untouched and
   * comes back in a later cycle. A permanent error of this transaction (domain invariant, integrity
   * refusal) makes it FAILED (INTERNAL_PERMANENT_ERROR), otherwise it would come back forever.
   */
  async recheck(candidate: PendingReferenceCandidate): Promise<RecheckOutcome> {
    let checked: Checked;
    try {
      checked = await this.runner.run((scope) => this.attempt(scope, candidate));
    } catch (error) {
      if (!(error instanceof DomainError || error instanceof PersistenceIntegrityError)) {
        throw error;
      }
      this.logger.error("pending reference re-check failed permanently", {
        transactionId: candidate.transactionId,
        walletId: candidate.walletId,
        error: error.message,
      });
      checked = await this.runner.run((scope) => this.failPermanently(scope, candidate));
    }
    const { outcome, transaction } = checked;
    this.metrics.pendingReferenceChecked(outcome);
    if (
      transaction !== undefined &&
      outcome !== WagerTransactionStatus.PendingReference &&
      outcome !== "SKIPPED"
    ) {
      this.metrics.wagerTransactionDecided(transaction.kind, outcome, "pending_worker");
      this.logger.info("pending reference resolved", {
        transactionId: candidate.transactionId,
        walletId: candidate.walletId,
        providerId: transaction.providerId,
        correlationId: transaction.correlationId,
        status: outcome,
      });
    }
    return outcome;
  }

  private async attempt(
    scope: TransactionScope,
    candidate: PendingReferenceCandidate,
  ): Promise<Checked> {
    const locked = await this.lockAndReread(scope, candidate);
    if (locked === undefined) return { outcome: "SKIPPED" };
    const { wallet, transaction, at } = locked;
    const attemptsRead = transaction.referenceAttempts;
    const versionRead = wallet.version;
    const context = this.context(transaction);

    const { outcome, events } = await settleUnderLock(scope.transactions, {
      transaction,
      wallet,
      ledgerEntryId: this.ids.next(),
      at,
      referenceRetry: {
        backoff: this.pendingReference.backoff,
        ttlMs: this.pendingReference.ttlMs,
        random: () => this.random.next(),
      },
      eventContext: () => this.eventContext(context, at),
    });

    await scope.transactions.updatePending(transaction, attemptsRead);
    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry !== undefined) {
      await scope.wallets.save(wallet, versionRead);
    }
    await scope.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
    // A resolved REFUND may be what a ROLLBACK waits for.
    await expediteWaitingDependents(scope.transactions, transaction, at);
    return { outcome: outcome.status, transaction };
  }

  private async failPermanently(
    scope: TransactionScope,
    candidate: PendingReferenceCandidate,
  ): Promise<Checked> {
    const locked = await this.lockAndReread(scope, candidate, { evenIfNotDue: true });
    if (locked === undefined) return { outcome: "SKIPPED" };
    const { transaction, at } = locked;
    const attemptsRead = transaction.referenceAttempts;
    transaction.fail({ code: FailureCode.InternalPermanentError, at });
    await scope.transactions.updatePending(transaction, attemptsRead);
    await scope.outbox.enqueue([
      OutboxMessage.enqueue(
        WagerTransactionFailed.from(transaction, this.eventContext(this.context(transaction), at)),
      ),
    ]);
    await expediteWaitingDependents(scope.transactions, transaction, at);
    return { outcome: WagerTransactionStatus.Failed, transaction };
  }

  /** Wallet lock first (the first statement), then the transaction read again under it. */
  private async lockAndReread(
    scope: TransactionScope,
    candidate: PendingReferenceCandidate,
    options: { readonly evenIfNotDue?: boolean } = {},
  ): Promise<Locked | undefined> {
    const lockStartedAt = performance.now();
    const wallet = await scope.wallets.lockById(candidate.walletId);
    this.metrics.walletLockWait((performance.now() - lockStartedAt) / 1000);
    if (wallet === undefined) {
      // A transaction always has its wallet (FK) and wallets are never deleted (trigger).
      throw new PersistenceIntegrityError("23503", "wager_transactions_wallet_fk", undefined);
    }
    const at = this.clock.now();
    const transaction = await scope.transactions.findById(candidate.transactionId);
    if (
      transaction === undefined ||
      transaction.walletId !== candidate.walletId ||
      transaction.status !== WagerTransactionStatus.PendingReference
    ) {
      return undefined;
    }
    if (options.evenIfNotDue !== true && !transaction.isReferenceCheckDue(at)) return undefined;
    return { wallet, transaction, at };
  }

  /**
   * The events keep the correlationId of the request that created the transaction; only rows
   * written before it was stored get a fresh one. The cause is the transaction itself.
   */
  private context(transaction: WagerTransaction): { correlationId: string; causationId: string } {
    return {
      correlationId: transaction.correlationId ?? this.ids.next(),
      causationId: transaction.id,
    };
  }

  private eventContext(
    context: { correlationId: string; causationId: string },
    at: Date,
  ): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: at,
    };
  }
}
