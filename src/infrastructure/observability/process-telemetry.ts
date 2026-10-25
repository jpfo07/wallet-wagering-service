import type { Registry } from "prom-client";
import { PinoLogger } from "./pino-logger.ts";
import type { PinoLoggerOptions } from "./pino-logger.ts";
import { PrometheusApplicationMetrics, createMetricsRegistry } from "./prometheus-metrics.ts";

export type ProcessName = "api" | "sqs-consumer" | "outbox-publisher" | "pending-reference-worker";

/** The logger and metrics of one process, shared by everything running in it. */
export interface ProcessTelemetry {
  readonly registry: Registry;
  readonly logger: PinoLogger;
  readonly metrics: PrometheusApplicationMetrics;
}

export function createProcessTelemetry(options: {
  readonly process: ProcessName;
  readonly instanceId: string;
  readonly defaultMetrics?: boolean;
  readonly logDestination?: PinoLoggerOptions["destination"];
}): ProcessTelemetry {
  const registry = createMetricsRegistry(options);
  return {
    registry,
    logger: PinoLogger.create({
      base: { process: options.process, instanceId: options.instanceId },
      ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
    }),
    metrics: new PrometheusApplicationMetrics(registry),
  };
}
