import { InvariantViolationError } from "../shared/domain-error.ts";

export class InsufficientBalanceError extends InvariantViolationError {
  constructor(walletId: string) {
    super(
      "INSUFFICIENT_BALANCE",
      `debit would make wallet ${walletId} negative; check canDebit() before debiting`,
    );
  }
}

export class InvalidLedgerEntryError extends InvariantViolationError {
  constructor(message: string) {
    super("INVALID_LEDGER_ENTRY", message);
  }
}

export class DuplicateLedgerMovementError extends InvariantViolationError {
  constructor(walletId: string, transactionId: string) {
    super(
      "DUPLICATE_LEDGER_MOVEMENT",
      `transaction ${transactionId} already moved wallet ${walletId}`,
    );
  }
}

export class InvalidWalletError extends InvariantViolationError {
  constructor(message: string) {
    super("INVALID_WALLET", message);
  }
}
