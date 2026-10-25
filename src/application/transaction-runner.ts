import type { ExponentialBackoff } from "../domain/shared/backoff-policy.ts";
import { TransientFailureError, TransientPersistenceError } from "./errors.ts";
import type { RandomSource, Sleeper } from "./ports/system.ts";
import { lockConflictOf } from "./ports/telemetry.ts";
import type { ApplicationMetrics, Logger } from "./ports/telemetry.ts";
import type { TransactionScope, UnitOfWork, UnitOfWorkOptions } from "./ports/unit-of-work.ts";

export interface TransientRetryPolicy {
  /** Total attempts, including the first one. */
  readonly maxAttempts: number;
  readonly backoff: ExponentialBackoff;
}

/**
 * Runs a unit of work and repeats it, a bounded number of times, when it fails with a transient
 * persistence error. Each attempt is a whole new SQL transaction starting from the wallet lock:
 * the failed one was aborted, so nothing of it was persisted, and the persistent idempotency
 * protects the rest (even an ambiguous COMMIT: the repetition finds the row and replays it).
 * Anything else (business errors, integrity errors, bugs) is never retried.
 */
export class TransactionRunner {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: TransientRetryPolicy,
    private readonly sleeper: Sleeper,
    private readonly random: RandomSource,
    private readonly metrics: ApplicationMetrics,
    private readonly logger: Logger,
  ) {}

  async run<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options?: UnitOfWorkOptions,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.unitOfWork.run(work, options);
      } catch (error) {
        if (!(error instanceof TransientPersistenceError)) throw error;
        const conflict = lockConflictOf(error.reason);
        if (conflict !== undefined) this.metrics.lockConflict(conflict);
        if (attempt >= this.policy.maxAttempts) {
          throw new TransientFailureError(attempt, error);
        }
        const delayMs = this.policy.backoff.delayFor(attempt - 1, () => this.random.next());
        this.metrics.transientRetry(error.reason);
        this.logger.warn("transient persistence error, retrying", {
          reason: error.reason,
          attempt,
          delayMs,
        });
        await this.sleeper.sleep(delayMs);
      }
    }
  }
}
