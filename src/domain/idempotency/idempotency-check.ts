import { InvalidOperationError } from "../shared/domain-error.ts";
import { ErrorCode } from "../shared/failure-code.ts";
import type { WagerTransaction } from "../wager/wager-transaction.ts";

export interface IdempotencyCheckInput {
  /** Existing transaction with the same idempotency key, if any. */
  readonly byKey: WagerTransaction | undefined;
  /** Existing transaction with the same (providerId, externalTransactionId), if any. */
  readonly byExternalId: WagerTransaction | undefined;
  readonly incoming: { readonly idempotencyKey: string; readonly payloadHash: string };
}

export type IdempotencyDecision =
  | { readonly type: "NEW" }
  | { readonly type: "REPLAY"; readonly transaction: WagerTransaction }
  | {
      readonly type: "CONFLICT";
      readonly code: ErrorCode.IdempotencyKeyReused | ErrorCode.ExternalTransactionIdConflict;
      readonly transaction: WagerTransaction;
    };

/**
 * The idempotency key is the source of truth:
 * - same key, same payload hash → REPLAY (original response, including REJECTED/PENDING_REFERENCE);
 * - same key, different payload → conflict, never a replay;
 * - new key but the (providerId, externalTransactionId) already exists → conflict, even with an
 *   identical payload (one provider operation cannot live under two keys).
 */
export function checkIdempotency(input: IdempotencyCheckInput): IdempotencyDecision {
  const { byKey, byExternalId, incoming } = input;
  if (byKey !== undefined) {
    if (byKey.idempotencyKey !== incoming.idempotencyKey) {
      throw new InvalidOperationError("byKey must have the incoming idempotency key");
    }
    return byKey.matchesPayload(incoming.payloadHash)
      ? { type: "REPLAY", transaction: byKey }
      : { type: "CONFLICT", code: ErrorCode.IdempotencyKeyReused, transaction: byKey };
  }
  if (byExternalId !== undefined) {
    return {
      type: "CONFLICT",
      code: ErrorCode.ExternalTransactionIdConflict,
      transaction: byExternalId,
    };
  }
  return { type: "NEW" };
}
