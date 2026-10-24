import { InvariantViolationError, ValidationError } from "../shared/domain-error.ts";
import type { ErrorCode } from "../shared/failure-code.ts";
import type { WagerTransactionStatus } from "./wager-transaction-status.ts";

export type WagerValidationCode =
  | ErrorCode.InvalidPayload
  | ErrorCode.InvalidAmount
  | ErrorCode.KindNotAllowed
  | ErrorCode.ProviderReserved
  | ErrorCode.ReferenceRequired
  | ErrorCode.ReferenceNotAllowed
  | ErrorCode.SelfReference;

export class InvalidWagerTransactionError extends ValidationError<WagerValidationCode> {}

export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(transactionId: string, from: WagerTransactionStatus, transition: string) {
    super(
      "INVALID_TRANSACTION_STATE",
      `transaction ${transactionId} cannot ${transition} from status ${from}`,
    );
  }
}
