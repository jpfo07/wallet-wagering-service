import type { IdGenerator } from "../../application/ports/system.ts";

export const CORRELATION_ID_HEADER = "X-Correlation-Id";

// Safe to log and to echo in a header: no spaces, quotes or control characters.
const ACCEPTED = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The caller's correlation id when it is acceptable; otherwise (absent, repeated or junk) a new
 * one. An invalid value is replaced, not refused: correlation is diagnostics, not business data.
 */
export function resolveCorrelationId(header: unknown, ids: IdGenerator): string {
  return typeof header === "string" && ACCEPTED.test(header) ? header : ids.next();
}
