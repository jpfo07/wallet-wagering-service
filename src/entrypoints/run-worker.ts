import type { SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../infrastructure/config/env.ts";
import { installGracefulShutdown } from "./graceful-shutdown.ts";

export type WorkerName = "sqs-consumer" | "outbox-publisher" | "pending-reference-worker";

/**
 * Common bootstrap of a worker process: Nest application context (DI + ORM + SQS client),
 * internal health server and graceful shutdown. The work loop itself is plugged in by
 * the phase that implements it (5: sqs-consumer, 6: outbox-publisher and
 * pending-reference-worker); until then the process only stays up and healthy.
 */
export async function runWorker(name: WorkerName): Promise<void> {
  const config = loadConfig();
  const log = (message: string): void => {
    console.log(
      JSON.stringify({ level: "info", process: name, instanceId: config.instanceId, message }),
    );
  };

  // Signal handler first, heavy modules after it (see graceful-shutdown.ts).
  const shutdown = installGracefulShutdown({ timeoutMs: 10_000, log });
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
  shutdown.register(async () => {
    await health.stop();
    await app.close();
  });

  log(`started (health on port ${health.port}); no work loop yet — placeholder until its phase`);
}
