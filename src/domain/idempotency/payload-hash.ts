import { createHash } from "node:crypto";
import type { Money } from "../shared/money.ts";
import type { WagerTransactionKind } from "../wager/wager-transaction-kind.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { CanonicalJsonValue } from "./canonical-json.ts";

/** The business subset of a wager request. Idempotency key and transport metadata are excluded. */
export interface WagerPayloadFields {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
}

export const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * payloadHash = lowercase hex SHA-256 of the canonical JSON of the business subset. Fields are
 * picked one by one, so extra properties (idempotencyKey, messageId, occurredAt…) never leak in,
 * and the same operation hashes the same whether it came over HTTP or SQS.
 */
export function computeWagerPayloadHash(fields: WagerPayloadFields): string {
  const subset: CanonicalJsonValue = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(subset));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
