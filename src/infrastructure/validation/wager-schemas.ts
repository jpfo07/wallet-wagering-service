import { z } from "zod";

/**
 * Shape schemas shared by the transport adapters (HTTP body and SQS message `data`), so both
 * entrances accept exactly the same wager. Shape only: types, required fields, lengths, no unknown
 * fields. Semantic rules stay in the domain and the use cases (strict Money format, OPENING,
 * reserved provider, references), which raise their own stable codes; repeating them here would
 * turn KIND_NOT_ALLOWED into a generic error.
 */

/** Same rule as the schema's text CHECKs: not blank, at most 255 characters. */
export const text = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() !== "", "must not be blank");

// Any case: the application normalizes UUIDs to lowercase before the payload hash.
export const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");

export const money = z.strictObject({ amount: z.string(), currency: z.string() });

export const wagerTransactionBody = z.strictObject({
  providerId: text,
  externalTransactionId: text,
  playerId: uuid,
  walletId: uuid,
  roundId: text,
  gameId: text,
  kind: z.string(),
  money,
  referenceExternalTransactionId: text.optional(),
});

// Safe to log and to echo in a header: no spaces, quotes or control characters.
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isAcceptableCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_ID.test(value);
}
