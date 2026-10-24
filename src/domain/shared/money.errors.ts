import { InvariantViolationError, ValidationError } from "./domain-error.ts";
import type { ErrorCode } from "./failure-code.ts";

export class InvalidMoneyError extends ValidationError<
  ErrorCode.InvalidAmount | ErrorCode.InvalidCurrency
> {}

export class CurrencyMismatchError extends InvariantViolationError {
  constructor(expected: string, actual: string) {
    super("MONEY_CURRENCY_MISMATCH", `currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class MoneyOverflowError extends InvariantViolationError {
  constructor() {
    super("MONEY_OVERFLOW", "amount exceeds the supported range of numeric(20,2)");
  }
}
