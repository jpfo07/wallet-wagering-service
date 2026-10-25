import type { WagerTransactionResult } from "../../application/views.ts";
import { CodeCategory, FAILURE_CODE_CATALOG } from "../../domain/shared/failure-code.ts";
import { WagerTransactionStatus } from "../../domain/wager/wager-transaction-status.ts";

const STATUS_BY_CATEGORY: Readonly<Record<CodeCategory, number>> = Object.freeze({
  [CodeCategory.InvalidPayload]: 400,
  [CodeCategory.Unauthenticated]: 401,
  [CodeCategory.Forbidden]: 403,
  [CodeCategory.NotFound]: 404,
  [CodeCategory.Conflict]: 409,
  [CodeCategory.BusinessRejection]: 422,
  // FAILED is terminal: resending only replays it. A 5xx would invite the provider to retry.
  [CodeCategory.PermanentFailure]: 422,
  [CodeCategory.Transient]: 503,
});

export function statusForCategory(category: CodeCategory): number {
  return STATUS_BY_CATEGORY[category];
}

/**
 * Status of a submitted transaction, from its status (new or replay alike): the provider decides
 * what to do from the status code and the failureCode, never from a message.
 */
export function httpStatusForResult(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return result.failureCode === undefined
        ? statusForCategory(CodeCategory.BusinessRejection)
        : statusForCategory(FAILURE_CODE_CATALOG[result.failureCode].category);
  }
}
