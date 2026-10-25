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

/** Room, beyond the consumer drain and its last long poll, for closing health, ORM and SQS. */
const CLOSE_MARGIN_MS = 4_000;

/**
 * Common bootstrap of a worker process: Nest application context (DI + ORM + SQS client),
 * internal health server and graceful shutdown. The work loop is plugged in by each entrypoint
 * (the outbox publisher and the pending-reference worker still have none); it must be loaded with
 * `await import()` inside `start`, after the signal handler exists.
 */
export async function runWorker(name: WorkerName, start?: StartWorkLoop): Promise<void> {
  const config = loadConfig();
  const log = (message: string): void => {
    console.log(
      JSON.stringify({ level: "info", process: name, instanceId: config.instanceId, message }),
    );
  };

  // Signal handler first, heavy modules after it (see graceful-shutdown.ts).
  const shutdown = installGracefulShutdown({
    timeoutMs: Math.max(
      10_000,
      Math.max(config.sqsConsumer.shutdownDrainMs, config.sqsConsumer.waitTimeSeconds * 1000) +
        CLOSE_MARGIN_MS,
    ),
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

  if (start === undefined) {
    log(`started (health on port ${health.port}); no work loop yet — placeholder until its phase`);
    return;
  }
  loop = await start(app, config);
  log(`started (health on port ${health.port})`);
}
