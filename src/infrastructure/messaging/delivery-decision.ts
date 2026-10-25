import {
  ApplicationError,
  PoisonMessageError,
  TransientFailureError,
  TransientPersistenceError,
} from "../../application/errors.ts";
import type { WagerTransactionResult } from "../../application/views.ts";
import { ValidationError } from "../../domain/shared/domain-error.ts";
import { CodeCategory, ERROR_CODE_CATALOG, ErrorCode } from "../../domain/shared/failure-code.ts";

/** Codes that exist only in the consumer (never raised by a use case). */
export enum ConsumerFailureCode {
  MalformedMessage = "MALFORMED_MESSAGE",
  PoisonMessage = "POISON_MESSAGE",
  Unexpected = "UNEXPECTED_ERROR",
}

/**
 * What to do with a received message:
 * - ack: DeleteMessage. The outcome is final (persisted, or a terminal answer such as
 *   WALLET_NOT_FOUND); a redelivery would only repeat it.
 * - retry: leave it in the queue with a longer visibility. After maxReceiveCount the broker's
 *   redrive policy moves it to the DLQ.
 * - dlq: known to never succeed. Sent to the DLQ at once instead of burning every receive (and
 *   holding the wallet's FIFO group) until the redrive.
 */
export type DeliveryDecision =
  | { readonly action: "ack"; readonly outcome: string; readonly log: "info" | "warn" }
  | {
      readonly action: "retry";
      readonly reason: string;
      /** The database itself looks unreachable: the consumer stops fetching until it answers. */
      readonly databaseUnavailable: boolean;
      readonly log: "warn" | "error";
    }
  | { readonly action: "dlq"; readonly failureCode: string; readonly reason: string };

export function decideForResult(result: WagerTransactionResult): DeliveryDecision {
  return {
    action: "ack",
    outcome: result.failureCode ?? result.status,
    log: "info",
  };
}

const ERROR_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

function isErrorCode(code: string): code is ErrorCode {
  return ERROR_CODES.has(code);
}

/** By the category of the code, like the HTTP mapping: a new code lands in the right action. */
export function decideForError(error: unknown): DeliveryDecision {
  if (error instanceof PoisonMessageError) {
    return { action: "dlq", failureCode: ConsumerFailureCode.PoisonMessage, reason: error.message };
  }
  if (error instanceof TransientFailureError) {
    const reason = transientReason(error);
    return {
      action: "retry",
      reason,
      databaseUnavailable: isConnectionFailure(reason),
      log: "warn",
    };
  }
  if (error instanceof ValidationError || error instanceof ApplicationError) {
    // instanceof on the generic classes yields `any` type arguments; pin the defaults.
    const code: string = (error as ValidationError | ApplicationError).code;
    if (isErrorCode(code)) {
      switch (ERROR_CODE_CATALOG[code].category) {
        case CodeCategory.InvalidPayload:
          return { action: "dlq", failureCode: code, reason: error.message };
        case CodeCategory.NotFound:
        case CodeCategory.Conflict:
          return { action: "ack", outcome: code, log: "warn" };
        case CodeCategory.Transient:
          return { action: "retry", reason: code, databaseUnavailable: false, log: "warn" };
        case CodeCategory.BusinessRejection:
        case CodeCategory.PermanentFailure:
          // Persisted outcomes come back as results, never as errors.
          break;
      }
    }
  }
  // Integrity errors, stale version, violated invariants, bugs: not provably permanent (could be
  // environmental), so retried a few times and dead-lettered by the redrive policy.
  return {
    action: "retry",
    reason: error instanceof Error ? error.name : ConsumerFailureCode.Unexpected,
    databaseUnavailable: false,
    log: "error",
  };
}

function transientReason(error: TransientFailureError): string {
  return error.cause instanceof TransientPersistenceError ? error.cause.reason : "unknown";
}

/** Reasons from persistence-error-classifier that mean "no database", not "busy database". */
const CONNECTION_REASONS: ReadonlySet<string> = new Set([
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "connection",
]);

export function isConnectionFailure(reason: string): boolean {
  return reason.startsWith("08") || CONNECTION_REASONS.has(reason);
}
