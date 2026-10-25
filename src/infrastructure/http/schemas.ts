import { z } from "zod";
import { MAX_LEDGER_PAGE_LIMIT } from "../../application/queries/queries.ts";

/**
 * Shape only: types, required fields, lengths, no unknown fields. Semantic rules stay in the domain
 * and the use cases (strict Money format, OPENING, reserved provider, references), which raise
 * their own stable codes; repeating them here would turn KIND_NOT_ALLOWED into a generic error.
 */

/** Same rule as the schema's text CHECKs: not blank, at most 255 characters. */
const text = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() !== "", "must not be blank");

// Any case: the application normalizes UUIDs to lowercase before the payload hash.
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");

const money = z.strictObject({ amount: z.string(), currency: z.string() });

export const createWalletBody = z.strictObject({
  playerId: uuid,
  initialBalance: money,
});

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

export const idempotencyKeyHeader = text;

export const DEFAULT_LEDGER_PAGE_LIMIT = 50;

export const ledgerQuery = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^\d{1,4}$/, `must be an integer between 1 and ${MAX_LEDGER_PAGE_LIMIT}`)
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(1).max(MAX_LEDGER_PAGE_LIMIT))
    .optional(),
});
