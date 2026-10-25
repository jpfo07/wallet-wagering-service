import type { RandomSource, Sleeper } from "../../application/ports/system.ts";
import type { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import { classifyPersistenceError, isConnectionFailure } from "./persistence-error-classifier.ts";

export interface ConnectionRetryOptions {
  /** Total attempts, including the first one. */
  readonly attempts: number;
  readonly backoff: ExponentialBackoff;
  readonly sleeper: Sleeper;
  readonly random: RandomSource;
  readonly onRetry?: (info: { attempt: number; reason: string; delayMs: number }) => void;
}

/**
 * Repeats `work` while it fails because the database cannot be reached yet (57P03 while the server
 * is starting, class 08, 57P01, network errors), with backoff and a limit. Any other error, a busy
 * database (lock, deadlock) included, is thrown at once. `work` must be safe to repeat from scratch.
 */
export async function withConnectionRetry<T>(
  work: () => Promise<T>,
  options: ConnectionRetryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const classified = classifyPersistenceError(error);
      const retryable = classified.kind === "transient" && isConnectionFailure(classified.reason);
      if (!retryable || attempt >= options.attempts) throw error;
      const delayMs = options.backoff.delayFor(attempt - 1, () => options.random.next());
      options.onRetry?.({ attempt, reason: classified.reason, delayMs });
      await options.sleeper.sleep(delayMs);
    }
  }
}
