import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Registry } from "prom-client";
import type { Clock, RandomSource } from "../../application/ports/system.ts";
import type { Logger } from "../../application/ports/telemetry.ts";
import type { ProcessWagerTransaction } from "../../application/wager/process-wager-transaction.ts";
import { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import type {
  DatabaseConfig,
  SqsConfig,
  SqsConsumerConfig,
  TransientRetryConfig,
} from "../config/env.ts";
import { registerDlqDepthGauge } from "../observability/prometheus-metrics.ts";
import { DatabaseGate } from "./database-gate.ts";
import { inspectWagerQueue } from "./queue-attributes.ts";
import { assertVisibilityBudget, worstCaseProcessingMs } from "./visibility-budget.ts";
import { WAGER_CONSUMER_NAME, WagerQueueConsumer } from "./wager-queue-consumer.ts";
import type { ConsumerMetrics } from "./wager-queue-consumer.ts";

export interface WagerConsumerSetup {
  readonly sqs: SQSClient;
  readonly sqsConfig: SqsConfig;
  readonly consumer: SqsConsumerConfig;
  readonly database: DatabaseConfig;
  readonly transientRetry: TransientRetryConfig;
  readonly processWager: ProcessWagerTransaction;
  /** Any cheap round trip to PostgreSQL (`select 1`). */
  readonly pingDatabase: () => Promise<unknown>;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly logger: Logger;
  readonly metrics: ConsumerMetrics;
  /** When present, the DLQ depth gauge is registered on it (the queue URL is known after boot). */
  readonly metricsRegistry?: Registry;
}

/** The DLQ depth is read at scrape time; a slow SQS must not hold the scrape. */
export const DLQ_DEPTH_TIMEOUT_MS = 2_000;

export interface RunningWagerConsumer {
  readonly consumer: WagerQueueConsumer;
  readonly gate: DatabaseGate;
  stop(): Promise<void>;
}

/**
 * Boot checks, then the loop. The consumer refuses to start when the queue has no redrive policy
 * to the configured DLQ, or a VisibilityTimeout shorter than the worst-case processing time.
 */
export async function startWagerConsumer(setup: WagerConsumerSetup): Promise<RunningWagerConsumer> {
  const topology = await inspectWagerQueue(setup.sqs, {
    queueName: setup.sqsConfig.wagerQueueName,
    dlqName: setup.sqsConfig.wagerDlqName,
  });
  const budget = {
    transientRetry: setup.transientRetry,
    lockTimeoutMs: setup.database.lockTimeoutMs,
    processingMarginMs: setup.consumer.processingMarginMs,
  };
  assertVisibilityBudget(topology.visibilityTimeoutSeconds, budget);
  if (setup.metricsRegistry !== undefined) {
    registerDlqDepthGauge(setup.metricsRegistry, {
      sqs: setup.sqs,
      dlqUrl: topology.dlqUrl,
      queueName: setup.sqsConfig.wagerDlqName,
      timeoutMs: DLQ_DEPTH_TIMEOUT_MS,
      logger: setup.logger,
    });
  }

  const gate = new DatabaseGate(
    setup.pingDatabase,
    {
      probeTimeoutMs: setup.consumer.databaseProbeTimeoutMs,
      freshnessMs: setup.consumer.databaseProbeFreshnessMs,
      backoff: ExponentialBackoff.of({
        baseMs: setup.consumer.databasePauseBaseMs,
        maxMs: setup.consumer.databasePauseMaxMs,
      }),
    },
    setup.clock,
    setup.random,
    setup.logger,
  );
  const consumer = new WagerQueueConsumer(
    {
      consumerName: WAGER_CONSUMER_NAME,
      queueUrl: topology.queueUrl,
      dlqUrl: topology.dlqUrl,
      concurrency: setup.consumer.concurrency,
      waitTimeSeconds: setup.consumer.waitTimeSeconds,
      retryBackoff: ExponentialBackoff.of({
        baseMs: setup.consumer.retryBaseMs,
        maxMs: setup.consumer.retryMaxMs,
      }),
      shutdownDrainMs: setup.consumer.shutdownDrainMs,
    },
    {
      sqs: setup.sqs,
      processWager: setup.processWager,
      gate,
      random: setup.random,
      logger: setup.logger,
      metrics: setup.metrics,
    },
  );
  consumer.start();
  setup.logger.info("sqs consumer started", {
    queue: setup.sqsConfig.wagerQueueName,
    concurrency: setup.consumer.concurrency,
    visibilityTimeoutSeconds: topology.visibilityTimeoutSeconds,
    worstCaseProcessingMs: worstCaseProcessingMs(budget),
    maxReceiveCount: topology.maxReceiveCount,
  });
  return { consumer, gate, stop: () => consumer.stop() };
}
