import { ConfigError } from "../config/env.ts";
import type { TransientRetryConfig } from "../config/env.ts";

export interface VisibilityBudgetInput {
  readonly transientRetry: TransientRetryConfig;
  readonly lockTimeoutMs: number;
  readonly processingMarginMs: number;
}

/**
 * Longest a message can stay in processing, from the retry settings:
 *
 *   (2 × attempts − 1) × lock_timeout + 2 × Σ backoff ceilings + margin
 *
 * The factor 2 is the single restart after a concurrent idempotency insert (ProcessWagerTransaction):
 * a first cycle can wait out attempts − 1 lock timeouts and then take the lock and hit the 23505,
 * and the restarted cycle can wait out all of them again. The margin covers the statements
 * themselves and the SQS round trips.
 */
export function worstCaseProcessingMs(input: VisibilityBudgetInput): number {
  const { maxAttempts, baseMs, maxMs } = input.transientRetry;
  let backoffCeilings = 0;
  for (let retry = 0; retry < maxAttempts - 1; retry += 1) {
    backoffCeilings += Math.min(maxMs, baseMs * 2 ** retry);
  }
  return (
    (2 * maxAttempts - 1) * input.lockTimeoutMs + 2 * backoffCeilings + input.processingMarginMs
  );
}

/**
 * The message must stay invisible while it is processed; otherwise another instance receives it
 * halfway. That would not duplicate effects (wallet lock + inbox + idempotency), but it burns
 * receives towards the DLQ. The consumer refuses to start when the queue cannot cover the budget.
 */
export function assertVisibilityBudget(
  visibilityTimeoutSeconds: number,
  input: VisibilityBudgetInput,
): void {
  const worstMs = worstCaseProcessingMs(input);
  if (visibilityTimeoutSeconds * 1000 <= worstMs) {
    throw new ConfigError(
      `VisibilityTimeout da fila (${visibilityTimeoutSeconds} s) não cobre o pior caso de ` +
        `processamento (${worstMs} ms); use pelo menos ${Math.floor(worstMs / 1000) + 1} s ` +
        `ou reduza DATABASE_LOCK_TIMEOUT_MS / DATABASE_TRANSIENT_RETRY_ATTEMPTS`,
    );
  }
}
