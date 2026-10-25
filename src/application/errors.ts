import { ValidationError } from "../domain/shared/domain-error.ts";
import { ErrorCode } from "../domain/shared/failure-code.ts";

/**
 * Outcomes that never become a persisted transaction. Transport adapters map them by the category
 * of their ErrorCode (see FAILURE/ERROR_CODE_CATALOG); persistence errors below are internal.
 */
export abstract class ApplicationError<C extends string = string> extends Error {
  constructor(
    readonly code: C,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Malformed command caught by the application before any SQL runs (HTTP 400). */
export class InvalidCommandError extends ValidationError<ErrorCode.InvalidPayload> {
  constructor(message: string) {
    super(ErrorCode.InvalidPayload, message);
  }
}

export class WalletNotFoundError extends ApplicationError<ErrorCode.WalletNotFound> {
  constructor(readonly walletId: string) {
    super(ErrorCode.WalletNotFound, `wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError<ErrorCode.TransactionNotFound> {
  constructor(description: string) {
    super(ErrorCode.TransactionNotFound, `transaction ${description} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError<ErrorCode.WalletAlreadyExists> {
  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(ErrorCode.WalletAlreadyExists, `player ${playerId} already has a ${currency} wallet`);
  }
}

export class IdempotencyConflictError extends ApplicationError<
  ErrorCode.IdempotencyKeyReused | ErrorCode.ExternalTransactionIdConflict
> {
  constructor(
    code: ErrorCode.IdempotencyKeyReused | ErrorCode.ExternalTransactionIdConflict,
    readonly existingTransactionId: string,
  ) {
    super(
      code,
      code === ErrorCode.IdempotencyKeyReused
        ? "the idempotency key was already used with a different payload"
        : "this externalTransactionId was already submitted under another idempotency key",
    );
  }
}

/** Same (consumerName, messageId) with a different payload: never processable (SQS → DLQ). */
export class PoisonMessageError extends ApplicationError<"POISON_MESSAGE"> {
  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(
      "POISON_MESSAGE",
      `message ${messageId} was already received by ${consumerName} with a different payload`,
    );
  }
}

/** Transient errors outlived the retry budget (HTTP 503 + Retry-After; SQS: visibility back). */
export class TransientFailureError extends ApplicationError<ErrorCode.TransientFailure> {
  constructor(
    readonly attempts: number,
    cause: unknown,
  ) {
    super(
      ErrorCode.TransientFailure,
      `transient infrastructure failure after ${attempts} attempt(s)`,
      { cause },
    );
  }
}

// ---- persistence errors (raised by the UnitOfWork adapter, handled by the application)

/** Lock timeout, deadlock, serialization failure, lost connection...: the attempt may be repeated. */
export class TransientPersistenceError extends ApplicationError<"TRANSIENT_PERSISTENCE"> {
  constructor(
    readonly reason: string,
    cause: unknown,
  ) {
    super("TRANSIENT_PERSISTENCE", `transient persistence error (${reason})`, { cause });
  }
}

/** Which business uniqueness a concurrent insert collided with. */
export enum UniqueTarget {
  IdempotencyKey = "IDEMPOTENCY_KEY",
  ExternalTransactionId = "EXTERNAL_TRANSACTION_ID",
}

/**
 * A concurrent transaction committed the same (providerId, idempotencyKey) or
 * (providerId, externalTransactionId) for another wallet, so the wallet lock did not serialize us.
 * Restarting the attempt sees the committed row and answers with replay or conflict.
 */
export class ConcurrentInsertConflictError extends ApplicationError<"CONCURRENT_INSERT_CONFLICT"> {
  constructor(
    readonly target: UniqueTarget,
    cause: unknown,
  ) {
    super("CONCURRENT_INSERT_CONFLICT", `concurrent insert conflict on ${target}`, { cause });
  }
}

/**
 * The database refused the state we tried to commit (integrity class 23, including the deferred
 * checks that only fire at COMMIT). In the normal path no constraint fires, so this is a bug:
 * never retried, logged as error.
 */
export class PersistenceIntegrityError extends ApplicationError<"PERSISTENCE_INTEGRITY"> {
  constructor(
    readonly sqlState: string,
    readonly constraint: string | undefined,
    cause: unknown,
  ) {
    super(
      "PERSISTENCE_INTEGRITY",
      `database refused the write: SQLSTATE ${sqlState}${constraint === undefined ? "" : ` (${constraint})`}`,
      { cause },
    );
  }
}

/**
 * The versioned UPDATE matched no row although we hold the wallet lock: someone wrote without the
 * lock, or the lock was lost. A bug, never retried (a retry would hide exactly what this guards).
 */
export class StaleWalletVersionError extends ApplicationError<"STALE_WALLET_VERSION"> {
  constructor(
    readonly walletId: string,
    readonly expectedVersion: number,
  ) {
    super(
      "STALE_WALLET_VERSION",
      `wallet ${walletId} is no longer at version ${expectedVersion} while its lock is held`,
    );
  }
}
