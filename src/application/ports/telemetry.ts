export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Structured logger. Fields are identifiers only, never full financial payloads. */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Where a wager transaction decision came from. */
export type TransactionSource = "http" | "sqs" | "pending_worker";

/**
 * Duplicates the persistent idempotency caught: a replay (same key, same payload), a conflict
 * (same key or externalId with another payload), an SQS redelivery already in the inbox, and a
 * poison message (same messageId, another payload).
 */
export type DuplicateType = "replay" | "idempotency_conflict" | "inbox_redelivery" | "poison";

/** Lock-related transient errors, by SQLSTATE. */
export type LockConflict = "lock_timeout" | "deadlock" | "serialization";

const LOCK_CONFLICTS: Readonly<Record<string, LockConflict>> = {
  "55P03": "lock_timeout",
  "40P01": "deadlock",
  "40001": "serialization",
};

/** The lock conflict behind a transient persistence reason, if it is one. */
export function lockConflictOf(reason: string): LockConflict | undefined {
  return LOCK_CONFLICTS[reason];
}

export interface WagerProcessingObservation {
  /** Validated kind, or "INVALID" (labels never carry raw input). */
  readonly kind: string;
  readonly source: TransactionSource;
  /** Final status, "REPLAY", or the error code that ended the request. */
  readonly outcome: string;
  readonly durationSeconds: number;
}

/**
 * What the use cases report. No observation carries money: counts, durations and low-cardinality
 * labels only (never walletId or providerId).
 */
export interface ApplicationMetrics {
  /** A transient persistence error that will be retried (reason = SQLSTATE or "connection"). */
  transientRetry(reason: string): void;
  /** Every lock timeout, deadlock or serialization failure, retried or not. */
  lockConflict(conflict: LockConflict): void;
  /** Time spent waiting for the wallet row lock (SELECT ... FOR UPDATE). */
  walletLockWait(seconds: number): void;
  duplicateDetected(type: DuplicateType): void;
  /** A transaction entered a status (new decisions only; a replay changes nothing). */
  wagerTransactionDecided(kind: string, status: string, source: TransactionSource): void;
  /** End-to-end latency of ProcessWagerTransaction, retries included. */
  wagerProcessed(observation: WagerProcessingObservation): void;
  reconciliationDivergence(): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(reason: string): void;
  /** Gauge: age of the oldest pending event (0 when none) and how many are pending. */
  outboxLag(oldestPendingAgeMs: number, pendingCount: number): void;
  /** Outcome of a PENDING_REFERENCE re-check: PROCESSED, REJECTED, FAILED, PENDING_REFERENCE, SKIPPED. */
  pendingReferenceChecked(outcome: string): void;
}
