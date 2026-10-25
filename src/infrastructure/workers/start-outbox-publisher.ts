import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { PublishOutboxBatch } from "../../application/outbox/publish-outbox-batch.ts";
import { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import { buildPublishOutboxBatch } from "../application/composition.ts";
import type { Application } from "../application/composition.ts";
import { ConfigError } from "../config/env.ts";
import type { DatabaseConfig, OutboxPublisherConfig } from "../config/env.ts";
import { SqsEventPublisher } from "../messaging/sqs-event-publisher.ts";
import { PollingLoop } from "./polling-loop.ts";

/** How often the outbox lag gauge is refreshed (one cheap query on the partial index). */
export const OUTBOX_LAG_SAMPLE_INTERVAL_MS = 1_000;

export interface OutboxPublisherSetup {
  /** Should have a request timeout (createSqsClient's requestTimeoutMs): row locks are held meanwhile. */
  readonly sqs: SQSClient;
  readonly eventsQueueName: string;
  readonly config: OutboxPublisherConfig;
  readonly database: DatabaseConfig;
  readonly application: Application;
}

export interface RunningOutboxPublisher {
  readonly publish: PublishOutboxBatch;
  stop(): Promise<void>;
}

/**
 * Each SQS call happens inside the batch's SQL transaction, with no statement running: it must end
 * before PostgreSQL's idle_in_transaction_session_timeout, or every batch would be cut.
 */
export function assertOutboxTimeouts(
  config: OutboxPublisherConfig,
  database: DatabaseConfig,
): void {
  if (config.sqsRequestTimeoutMs >= database.idleInTransactionTimeoutMs) {
    throw new ConfigError(
      `OUTBOX_SQS_REQUEST_TIMEOUT_MS (${config.sqsRequestTimeoutMs}) deve ser menor que ` +
        `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS (${database.idleInTransactionTimeoutMs})`,
    );
  }
}

export async function startOutboxPublisher(
  setup: OutboxPublisherSetup,
): Promise<RunningOutboxPublisher> {
  assertOutboxTimeouts(setup.config, setup.database);
  const { QueueUrl } = await setup.sqs.send(
    new GetQueueUrlCommand({ QueueName: setup.eventsQueueName }),
  );
  if (QueueUrl === undefined) throw new Error(`queue ${setup.eventsQueueName} not found`);

  const { clock, random, logger } = setup.application.dependencies;
  const publish = buildPublishOutboxBatch(
    setup.application,
    new SqsEventPublisher(setup.sqs, QueueUrl),
    setup.config,
  );
  let lastLagSampleAt = Number.NEGATIVE_INFINITY;
  const loop = new PollingLoop(
    async (signal) => {
      const result = await publish.execute(signal);
      const now = clock.now().getTime();
      if (now - lastLagSampleAt >= OUTBOX_LAG_SAMPLE_INTERVAL_MS) {
        lastLagSampleAt = now;
        await publish.measureLag();
      }
      return result.published > 0;
    },
    {
      name: "outbox-publisher",
      pollIntervalMs: setup.config.pollIntervalMs,
      errorBackoff: ExponentialBackoff.of({
        baseMs: setup.config.errorPauseBaseMs,
        maxMs: setup.config.errorPauseMaxMs,
      }),
    },
    random,
    logger,
  );
  loop.start();
  logger.info("outbox publisher started", {
    queue: setup.eventsQueueName,
    batchAggregates: setup.config.batchAggregates,
    maxEventsPerAggregate: setup.config.maxEventsPerAggregate,
  });
  return { publish, stop: () => loop.stop() };
}
