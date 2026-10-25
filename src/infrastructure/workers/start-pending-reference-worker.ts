import { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import type { Application } from "../application/composition.ts";
import type { PendingReferenceWorkerConfig } from "../config/env.ts";
import { PollingLoop } from "./polling-loop.ts";

export interface RunningPendingReferenceWorker {
  stop(): Promise<void>;
}

/**
 * The scheduled worker of section 7.1. Each cycle reads the due candidates (no lock) and re-checks
 * them one by one, each in its own SQL transaction that locks the wallet first. Stopping waits for
 * the candidate in progress and skips the rest of the batch (they stay due for the next process).
 */
export function startPendingReferenceWorker(setup: {
  readonly application: Application;
  readonly config: PendingReferenceWorkerConfig;
}): RunningPendingReferenceWorker {
  const { application, config } = setup;
  const { random, logger } = application.dependencies;
  const recheck = application.recheckPendingReferences;
  const loop = new PollingLoop(
    async (signal) => {
      const candidates = await recheck.dueCandidates(config.batchSize);
      let progressed = false;
      for (const candidate of candidates) {
        if (signal.aborted) break;
        try {
          await recheck.recheck(candidate);
          progressed = true;
        } catch (error) {
          // Transient (after the runner's retries) or unexpected: untouched, back in a later cycle.
          logger.warn("pending reference re-check failed, will retry", {
            transactionId: candidate.transactionId,
            walletId: candidate.walletId,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
        }
      }
      // A full batch means more may be due right now.
      return progressed && candidates.length >= config.batchSize;
    },
    {
      name: "pending-reference-worker",
      pollIntervalMs: config.pollIntervalMs,
      errorBackoff: ExponentialBackoff.of({
        baseMs: config.errorPauseBaseMs,
        maxMs: config.errorPauseMaxMs,
      }),
    },
    random,
    logger,
  );
  loop.start();
  logger.info("pending reference worker started", { batchSize: config.batchSize });
  return { stop: () => loop.stop() };
}
