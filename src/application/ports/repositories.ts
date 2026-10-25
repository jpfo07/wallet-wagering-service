import type { InboxMessage } from "../../domain/messaging/inbox-message.ts";
import type { OutboxMessage } from "../../domain/messaging/outbox-message.ts";
import type { Money } from "../../domain/shared/money.ts";
import type { WagerTransaction } from "../../domain/wager/wager-transaction.ts";
import type { Wallet } from "../../domain/wallet/wallet.ts";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry.ts";

/**
 * Repositories are bound to one SQL transaction (see UnitOfWork): every method runs inside it, and
 * nothing is cached between transactions.
 */
export interface WalletRepository {
  /**
   * SELECT ... FOR UPDATE on the wallet row. Must be the first statement of the transaction, so
   * every read after it sees whatever the previous lock holder committed.
   */
  lockById(id: string): Promise<Wallet | undefined>;

  findById(id: string): Promise<Wallet | undefined>;

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;

  /**
   * Inserts a new wallet and its pending ledger entries (the OPENING credit). Returns the entries
   * written, or undefined when (playerId, currency) is already taken (nothing is written then).
   */
  insertIfAbsent(wallet: Wallet): Promise<readonly WalletLedgerEntry[] | undefined>;

  /**
   * Appends the wallet's pending ledger entries and updates balance/version guarded by
   * `WHERE id = ? AND version = expectedVersion`. Zero rows updated is a bug (StaleWalletVersionError).
   */
  save(wallet: Wallet, expectedVersion: number): Promise<readonly WalletLedgerEntry[]>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;

  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;

  insert(transaction: WagerTransaction): Promise<void>;

  /** PROCESSED transactions whose reference_transaction_id is `referenceId`. */
  findProcessedDependents(referenceId: string): Promise<readonly WagerTransaction[]>;

  /** PROCESSED ROLLBACKs whose reference_transaction_id is one of `transactionIds`. */
  findProcessedRollbacksOf(transactionIds: readonly string[]): Promise<readonly WagerTransaction[]>;

  /**
   * PENDING_REFERENCE transactions whose next check is due, oldest first. A plain read, without
   * locks: the caller locks the wallet and reads the transaction again before deciding anything.
   */
  findDuePendingReferences(now: Date, limit: number): Promise<readonly PendingReferenceCandidate[]>;

  /**
   * Writes the outcome of a re-check of a PENDING_REFERENCE transaction, guarded by
   * `WHERE status = 'PENDING_REFERENCE' AND reference_attempts = expectedReferenceAttempts`.
   * Zero rows is a bug (StalePendingTransactionError): the wallet lock serializes re-checks.
   */
  updatePending(transaction: WagerTransaction, expectedReferenceAttempts: number): Promise<void>;

  /**
   * Brings forward the next check of the PENDING_REFERENCE transactions of `walletId` that wait
   * for (providerId, referenceExternalTransactionId), so the worker resolves them in its next
   * cycle instead of after their backoff. Scheduling only: no rule is decided here. Returns how
   * many were brought forward.
   */
  expediteReferenceChecks(props: {
    readonly walletId: string;
    readonly providerId: string;
    readonly referenceExternalTransactionId: string;
    readonly at: Date;
  }): Promise<number>;
}

export interface PendingReferenceCandidate {
  readonly transactionId: string;
  readonly walletId: string;
  /** For the worker's logs; the events take it from the transaction read under the lock. */
  readonly correlationId?: string | undefined;
}

export interface ReconciliationSnapshot {
  readonly storedBalance: Money;
  /** Credits minus debits; may be negative when the data is corrupted. */
  readonly calculatedBalance: Money;
  readonly checkedEntries: number;
}

export interface LedgerRepository {
  /** Entries ordered by wallet_version, strictly after `afterVersion` when given. */
  page(
    walletId: string,
    options: { readonly afterVersion: number | undefined; readonly limit: number },
  ): Promise<readonly WalletLedgerEntry[]>;

  /** Stored balance and ledger totals read by one statement, so both come from the same snapshot. */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface InboxRepository {
  /**
   * Records the delivery. When (consumerName, messageId) already exists, nothing is written and the
   * stored message is returned (`inserted: false`), even if another transaction inserted it
   * concurrently.
   */
  receive(
    message: InboxMessage,
  ): Promise<{ readonly message: InboxMessage; readonly inserted: boolean }>;

  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  /** Only writes; publishing happens later, after the commit, in the outbox publisher. */
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;

  /**
   * Locks due events for publication, preserving the order inside each aggregate: only the oldest
   * pending event of an aggregate (its head) can be claimed, with FOR UPDATE SKIP LOCKED, and
   * whoever holds the head also takes the next pending events of that aggregate. Returns them in
   * publication order (by sequence) and holds the locks until the transaction ends.
   */
  claimDue(
    now: Date,
    limits: { readonly aggregates: number; readonly eventsPerAggregate: number },
  ): Promise<readonly OutboxMessage[]>;

  /** Writes attempts / nextAttemptAt / publishedAt of a pending event (exactly one row). */
  save(message: OutboxMessage): Promise<void>;

  /** Pending events: how many and the occurredAt of the oldest (outbox lag). */
  pendingStats(): Promise<OutboxPendingStats>;
}

export interface OutboxPendingStats {
  readonly pendingCount: number;
  readonly oldestOccurredAt: Date | undefined;
}
