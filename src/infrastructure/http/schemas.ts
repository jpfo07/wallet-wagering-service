import { z } from "zod";
import { MAX_LEDGER_PAGE_LIMIT } from "../../application/queries/queries.ts";
import { money, text, uuid, wagerTransactionBody } from "../validation/wager-schemas.ts";

/** Shape of the HTTP inputs; the wager body is shared with the SQS consumer. */
export { wagerTransactionBody };

export const createWalletBody = z.strictObject({
  playerId: uuid,
  initialBalance: money,
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
