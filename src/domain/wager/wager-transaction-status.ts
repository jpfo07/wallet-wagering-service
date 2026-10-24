export enum WagerTransactionStatus {
  /** Accepted, not applied yet. */
  Pending = "PENDING",
  /** Waiting for the referenced transaction. */
  PendingReference = "PENDING_REFERENCE",
  /** Applied (terminal). */
  Processed = "PROCESSED",
  /** Business rule violation (terminal). */
  Rejected = "REJECTED",
  /** Permanent infrastructure error (terminal, auditable). */
  Failed = "FAILED",
}

export const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);
