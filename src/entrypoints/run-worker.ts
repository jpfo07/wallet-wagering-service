import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/core";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../infrastructure/config/env.ts";
import { SQS_CLIENT } from "../infrastructure/messaging/messaging.module.ts";
import { checkReadiness } from "../infrastructure/observability/readiness.ts";
import { startWorkerHealthServer } from "../infrastructure/observability/worker-health-server.ts";
import { WorkerModule } from "../infrastructure/worker.module.ts";
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
  installGracefulShutdown(app, { timeoutMs: 10_000, log, beforeClose: () => health.stop() });

  log(`started (health on port ${health.port}); no work loop yet — placeholder until its phase`);
}
