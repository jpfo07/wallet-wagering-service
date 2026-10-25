import type { INestApplicationContext } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { APPLICATION } from "../application/application.module.ts";
import type { Application } from "../application/composition.ts";
import type { AppConfig } from "../config/env.ts";
import { PROCESS_TELEMETRY } from "../observability/observability.module.ts";
import type { ProcessTelemetry } from "../observability/process-telemetry.ts";
import { PrometheusConsumerMetrics } from "../observability/prometheus-metrics.ts";
import { SQS_CLIENT } from "./messaging.module.ts";
import { startWagerConsumer } from "./start-wager-consumer.ts";
import type { RunningWagerConsumer } from "./start-wager-consumer.ts";

/** The sqs-consumer process: the consumer wired from the worker's Nest context. */
export function startWagerConsumerInNest(
  app: INestApplicationContext,
  config: AppConfig,
): Promise<RunningWagerConsumer> {
  const orm = app.get(MikroORM);
  const application = app.get<Application>(APPLICATION);
  const { clock, random, logger } = application.dependencies;
  const { registry } = app.get<ProcessTelemetry>(PROCESS_TELEMETRY);
  return startWagerConsumer({
    sqs: app.get<SQSClient>(SQS_CLIENT),
    sqsConfig: config.sqs,
    consumer: config.sqsConsumer,
    database: config.database,
    transientRetry: config.transientRetry,
    processWager: application.processWagerTransaction,
    pingDatabase: () => orm.em.getConnection().execute("select 1"),
    clock,
    random,
    logger,
    metrics: new PrometheusConsumerMetrics(registry),
    metricsRegistry: registry,
  });
}
