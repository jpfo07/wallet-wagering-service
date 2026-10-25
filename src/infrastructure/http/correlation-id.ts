import type { IdGenerator } from "../../application/ports/system.ts";
import { isAcceptableCorrelationId } from "../validation/wager-schemas.ts";

export const CORRELATION_ID_HEADER = "X-Correlation-Id";

/**
 * The caller's correlation id when it is acceptable; otherwise (absent, repeated or junk) a new
 * one. An invalid value is replaced, not refused: correlation is diagnostics, not business data.
 */
export function resolveCorrelationId(header: unknown, ids: IdGenerator): string {
  return isAcceptableCorrelationId(header) ? header : ids.next();
}
