import type { SQSClient } from "@aws-sdk/client-sqs";
import type { INestApplicationContext } from "@nestjs/common";
import { loadConfig } from "../infrastructure/config/env.ts";
import type { AppConfig } from "../infrastructure/config/env.ts";
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
  const log = (message: string): void => {
    console.log(
      JSON.stringify({ level: "info", process: name, instanceId: config.instanceId, message }),
    );
  };

  // Signal handler first, heavy modules after it (see graceful-shutdown.ts).
  const shutdown = installGracefulShutdown({
    timeoutMs: shutdownTimeoutMs(name, config),
    log,
  });
  log("starting");
  await import("reflect-metadata");
  const [
    { NestFactory },
    { MikroORM },
    { SQS_CLIENT },
    { checkReadiness },
    { startWorkerHealthServer },
    { WorkerModule },
  ] = await Promise.all([
    import("@nestjs/core"),
    import("@mikro-orm/core"),
    import("../infrastructure/messaging/messaging.module.ts"),
    import("../infrastructure/observability/readiness.ts"),
    import("../infrastructure/observability/worker-health-server.ts"),
    import("../infrastructure/worker.module.ts"),
  ]);

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["error", "warn"],
  });
  const orm = app.get(MikroORM);
  const sqs = app.get<SQSClient>(SQS_CLIENT);

  const health = startWorkerHealthServer({
    port: config.workerHealthPort,
    processName: name,
    instanceId: config.instanceId,
    readiness: () =>
      checkReadiness({
        pingPostgres: () => orm.em.getConnection().execute("select 1"),
        sqs,
        queueName: config.sqs.wagerQueueName,
      }),
  });
  // Assigned once the loop started; a SIGTERM during its boot checks finds it still undefined.
  let loop: WorkLoop | undefined = undefined;
  shutdown.register(async () => {
    await loop?.stop();
    await health.stop();
    await app.close();
  });

  loop = await start(app, config);
  log(`started (health on port ${health.port})`);
}
