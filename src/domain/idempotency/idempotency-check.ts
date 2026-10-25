import { InvalidOperationError } from "../shared/domain-error.ts";
import { ErrorCode } from "../shared/failure-code.ts";
import type { WagerTransaction } from "../wager/wager-transaction.ts";

export interface IdempotencyCheckInput {
  /** Existing transaction with the same (providerId, idempotencyKey), if any. */
  readonly byKey: WagerTransaction | undefined;
  /** Existing transaction with the same (providerId, externalTransactionId), if any. */
  readonly byExternalId: WagerTransaction | undefined;
  readonly incoming: {
    readonly providerId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
  };
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
 * Keys are scoped by provider: (providerId, idempotencyKey) is unique, so one provider can never
 * occupy, replay or conflict with another provider's keys.
 *
 * The idempotency key is the source of truth:
 * - same key, same payload hash → REPLAY (original response, including REJECTED/PENDING_REFERENCE);
 * - same key, different payload → conflict, never a replay;
 * - new key but the (providerId, externalTransactionId) already exists → conflict, even with an
 *   identical payload (one provider operation cannot live under two keys).
 */
export function checkIdempotency(input: IdempotencyCheckInput): IdempotencyDecision {
  const { byKey, byExternalId, incoming } = input;
  if (byExternalId !== undefined && byExternalId.providerId !== incoming.providerId) {
    throw new InvalidOperationError("byExternalId must belong to the incoming provider");
  }
  if (byKey !== undefined) {
    if (
      byKey.providerId !== incoming.providerId ||
      byKey.idempotencyKey !== incoming.idempotencyKey
    ) {
      throw new InvalidOperationError("byKey must have the incoming provider and idempotency key");
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
