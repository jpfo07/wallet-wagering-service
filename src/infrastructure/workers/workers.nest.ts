import type { INestApplicationContext } from "@nestjs/common";
import { APPLICATION } from "../application/application.module.ts";
import type { Application } from "../application/composition.ts";
import type { AppConfig } from "../config/env.ts";
import { createSqsClient } from "../messaging/sqs-client.factory.ts";
import { startOutboxPublisher } from "./start-outbox-publisher.ts";
import type { RunningOutboxPublisher } from "./start-outbox-publisher.ts";
import { startPendingReferenceWorker } from "./start-pending-reference-worker.ts";
import type { RunningPendingReferenceWorker } from "./start-pending-reference-worker.ts";

/**
 * The outbox-publisher process. It uses its own SQS client, with a request timeout and a single
 * SDK attempt: the batch holds row locks while it waits, and a failed send is already retried by
 * the outbox backoff.
 */
export async function startOutboxPublisherInNest(
  app: INestApplicationContext,
  config: AppConfig,
): Promise<RunningOutboxPublisher> {
  const sqs = createSqsClient(config.sqs, {
    requestTimeoutMs: config.outboxPublisher.sqsRequestTimeoutMs,
    maxAttempts: 1,
  });
  const running = await startOutboxPublisher({
    sqs,
    eventsQueueName: config.sqs.eventsQueueName,
    config: config.outboxPublisher,
    database: config.database,
    application: app.get<Application>(APPLICATION),
  });
  return {
    publish: running.publish,
    stop: async () => {
      await running.stop();
      sqs.destroy();
    },
  };
}

/** The pending-reference-worker process. */
export function startPendingReferenceWorkerInNest(
  app: INestApplicationContext,
  config: AppConfig,
): RunningPendingReferenceWorker {
  return startPendingReferenceWorker({
    application: app.get<Application>(APPLICATION),
    config: config.pendingReferenceWorker,
  });
}
