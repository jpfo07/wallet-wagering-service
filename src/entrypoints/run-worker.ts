import type { SQSClient } from "@aws-sdk/client-sqs";
import type { INestApplicationContext } from "@nestjs/common";
import { loadConfig } from "../infrastructure/config/env.ts";
import type { AppConfig } from "../infrastructure/config/env.ts";
import type { ProcessTelemetry } from "../infrastructure/observability/process-telemetry.ts";
import { bootLog } from "../infrastructure/observability/boot-log.ts";
import { installGracefulShutdown } from "./graceful-shutdown.ts";

export type WorkerName = "sqs-consumer" | "outbox-publisher" | "pending-reference-worker";

/** The work loop of a worker, started after boot and stopped first on SIGTERM. */
export interface WorkLoop {
  stop(): Promise<void>;
}

export type StartWorkLoop = (app: INestApplicationContext, config: AppConfig) => Promise<WorkLoop>;

/** Room, beyond the work in progress, for closing health, ORM and SQS. */
const CLOSE_MARGIN_MS = 4_000;
const MIN_SHUTDOWN_MS = 10_000;

/**
 * How long SIGTERM may take, from what each loop can still be doing when it is stopped:
 * - consumer: its drain, or the long poll in progress (whichever is longer);
 * - outbox publisher: the SQS call in progress (the batch sends no new layer once stopped);
 * - pending-reference worker: the candidate in progress, which may wait for the wallet lock on
 *   every transient attempt.
 * Killing any of them earlier is still safe (nothing is lost); this only makes the exit clean.
 */
export function shutdownTimeoutMs(name: WorkerName, config: AppConfig): number {
  const work = ((): number => {
    switch (name) {
      case "sqs-consumer":
        return Math.max(
          config.sqsConsumer.shutdownDrainMs,
          config.sqsConsumer.waitTimeSeconds * 1000,
        );
      case "outbox-publisher":
        return config.outboxPublisher.sqsRequestTimeoutMs;
      case "pending-reference-worker":
        return (
          config.transientRetry.maxAttempts *
          (config.database.lockTimeoutMs + config.transientRetry.maxMs)
        );
    }
  })();
  return Math.max(MIN_SHUTDOWN_MS, work + CLOSE_MARGIN_MS);
}

/**
 * Common bootstrap of a worker process: Nest application context (DI + ORM + SQS client),
 * internal health server and graceful shutdown. The work loop is plugged in by each entrypoint; it
 * must be loaded with `await import()` inside `start`, after the signal handler exists.
 */
export async function runWorker(name: WorkerName, start: StartWorkLoop): Promise<void> {
  const config = loadConfig();
  const log = bootLog({ process: name, instanceId: config.instanceId });

  // Signal handler first, heavy modules after it (see graceful-shutdown.ts).
  const shutdown = installGracefulShutdown({
    timeoutMs: shutdownTimeoutMs(name, config),
    log,
  });
  log("starting");
  await import("reflect-metadata");
  const [
    { NestFactory },
    { DatabaseProbe },
    { SQS_CLIENT },
    { PROCESS_TELEMETRY },
    { NestLoggerAdapter },
    { checkReadiness },
    { startWorkerHealthServer },
    { WorkerModule },
  ] = await Promise.all([
    import("@nestjs/core"),
    import("../infrastructure/persistence/database-probe.ts"),
    import("../infrastructure/messaging/messaging.module.ts"),
    import("../infrastructure/observability/observability.module.ts"),
    import("../infrastructure/observability/nest-logger.adapter.ts"),
    import("../infrastructure/observability/readiness.ts"),
    import("../infrastructure/observability/worker-health-server.ts"),
    import("../infrastructure/worker.module.ts"),
  ]);

  const app = await NestFactory.createApplicationContext(WorkerModule.forProcess(name), {
    bufferLogs: true,
  });
  app.useLogger(
    new NestLoggerAdapter(app.get<ProcessTelemetry>(PROCESS_TELEMETRY).logger, ["error", "warn"]),
  );
  const database = app.get(DatabaseProbe);
  const sqs = app.get<SQSClient>(SQS_CLIENT);
  const { registry } = app.get<ProcessTelemetry>(PROCESS_TELEMETRY);

  const health = startWorkerHealthServer({
    port: config.workerHealthPort,
    processName: name,
    instanceId: config.instanceId,
    metrics: registry,
    // Ready only once the loop runs: before that the process takes no work.
    isStarted: () => loop !== undefined,
    readiness: () =>
      checkReadiness({
        pingPostgres: () => database.ping(),
        sqs,
        queueName: config.sqs.wagerQueueName,
      }),
  });
  // Assigned once the loop started (readiness waits for it).
  let loop: WorkLoop | undefined = undefined;
  // A SIGTERM while `start` is still running (boot checks, first queries) waits for it and then
  // stops the loop it produced: closing the application under a starting loop would pull the ORM
  // and the SQS client from under it. A start that failed has nothing to stop.
  const starting = start(app, config);
  shutdown.register(async () => {
    const started = await starting.catch(() => undefined);
    await started?.stop();
    await health.stop();
    await app.close();
  });

  loop = await starting;
  log(`started (health on port ${health.port})`);
}
