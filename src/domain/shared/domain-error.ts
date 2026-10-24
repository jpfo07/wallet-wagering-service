import type { ErrorCode } from "./failure-code.ts";

export type InvariantCode =
  | "MONEY_CURRENCY_MISMATCH"
  | "MONEY_OVERFLOW"
  | "INSUFFICIENT_BALANCE"
  | "INVALID_LEDGER_ENTRY"
  | "DUPLICATE_LEDGER_MOVEMENT"
  | "INVALID_WALLET"
  | "INVALID_TRANSACTION_STATE"
  | "INVALID_REFERENCE_STATE"
  | "INVALID_INBOX_STATE"
  | "INVALID_OUTBOX_STATE"
  | "CANONICAL_JSON_UNSUPPORTED_VALUE"
  | "INVALID_OPERATION";

export abstract class DomainError<C extends string = string> extends Error {
  constructor(
    readonly code: C,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad input: the request must be fixed by whoever sent it (never persisted, HTTP 400). */
export abstract class ValidationError<C extends ErrorCode = ErrorCode> extends DomainError<C> {}

/**
 * A domain invariant was violated. This is a bug in the caller, never a business outcome:
 * business rules produce results (REJECTED + FailureCode), not exceptions.
 */
export class InvariantViolationError extends DomainError<InvariantCode> {}

export class InvalidOperationError extends InvariantViolationError {
  constructor(message: string) {
    super("INVALID_OPERATION", message);
  }
}
