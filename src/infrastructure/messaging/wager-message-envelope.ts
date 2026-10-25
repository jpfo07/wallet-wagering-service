import { z } from "zod";
import { text, wagerTransactionBody } from "../validation/wager-schemas.ts";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

/**
 * The message of wager-transactions.fifo. `data` is the same shape as the HTTP body plus the
 * idempotencyKey (which HTTP takes from a header). Strict at every level: an unknown field is a
 * malformed message, not something to ignore in silence.
 */
export const wagerMessageEnvelope = z.strictObject({
  /** The producer's id of the message: the inbox key, stable across producer resends. */
  messageId: text,
  type: z.literal(WAGER_TRANSACTION_REQUESTED),
  occurredAt: z.iso.datetime({ offset: true }),
  data: wagerTransactionBody.extend({ idempotencyKey: text }),
});

export type WagerMessageEnvelope = z.infer<typeof wagerMessageEnvelope>;

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: WagerMessageEnvelope }
  | { readonly ok: false; readonly reason: string };

/** Never throws: anything that is not a valid envelope is reported as malformed. */
export function parseWagerMessage(body: string | undefined): EnvelopeParseResult {
  if (body === undefined) return { ok: false, reason: "empty body" };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  const parsed = wagerMessageEnvelope.safeParse(json);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, reason: `invalid envelope (${issues})` };
}
