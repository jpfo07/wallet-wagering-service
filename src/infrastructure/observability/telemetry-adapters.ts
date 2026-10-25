import type { ApplicationMetrics, LogFields, Logger } from "../../application/ports/telemetry.ts";
import type { DeliveryDecision } from "../messaging/delivery-decision.ts";
import type { ConsumerMetrics } from "../messaging/wager-queue-consumer.ts";

type Level = "info" | "warn" | "error";

/** One JSON object per line on stdout. Replaced by pino in the observability phase. */
export class JsonLineLogger implements Logger {
  constructor(private readonly base: LogFields = {}) {}

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: Level, message: string, fields: LogFields = {}): void {
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      msg: message,
      ...this.base,
      ...fields,
    });
    process.stdout.write(`${line}\n`);
  }
}

export class SilentLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

export type ApplicationMetricName =
  | "transient_retry"
  | "idempotent_replay"
  | "idempotency_conflict"
  | "reconciliation_divergence"
  | "outbox_published"
  | "outbox_publish_failed"
  | "pending_reference_checked";

export type ApplicationGaugeName = "outbox_oldest_pending_age_ms" | "outbox_pending";

/**
 * Process-local counters. They are observability only, never a correctness mechanism; the
 * Prometheus exporter (/metrics) reads the same counters in the observability phase.
 */
export class InMemoryApplicationMetrics implements ApplicationMetrics {
  private readonly counters = new Map<string, number>();

  transientRetry(reason: string): void {
    this.increment(`transient_retry{reason=${reason}}`);
    this.increment("transient_retry");
  }

  idempotentReplay(): void {
    this.increment("idempotent_replay");
  }

  idempotencyConflict(): void {
    this.increment("idempotency_conflict");
  }

  reconciliationDivergence(): void {
    this.increment("reconciliation_divergence");
  }

  outboxPublished(count: number): void {
    this.increment("outbox_published", count);
  }

  outboxPublishFailed(reason: string): void {
    this.increment(`outbox_publish_failed{reason=${reason}}`);
    this.increment("outbox_publish_failed");
  }

  outboxLag(oldestPendingAgeMs: number, pendingCount: number): void {
    this.gauges.set("outbox_oldest_pending_age_ms", oldestPendingAgeMs);
    this.gauges.set("outbox_pending", pendingCount);
  }

  pendingReferenceChecked(outcome: string): void {
    this.increment(`pending_reference_checked{outcome=${outcome}}`);
    this.increment("pending_reference_checked");
  }

  count(name: ApplicationMetricName | `${ApplicationMetricName}{${string}}`): number {
    return this.counters.get(name) ?? 0;
  }

  gauge(name: ApplicationGaugeName): number | undefined {
    return this.gauges.get(name);
  }

  private readonly gauges = new Map<ApplicationGaugeName, number>();

  private increment(key: string, by = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
}

/** Process-local counters of the SQS consumer (Prometheus in the observability phase). */
export class InMemoryConsumerMetrics implements ConsumerMetrics {
  private readonly counters = new Map<string, number>();

  received(count: number): void {
    this.increment("sqs_received", count);
  }

  handled(action: DeliveryDecision["action"], outcome: string): void {
    this.increment(`sqs_handled{action=${action},outcome=${outcome}}`);
    this.increment(`sqs_handled{action=${action}}`);
  }

  deleteFailed(): void {
    this.increment("sqs_delete_failed");
  }

  released(count: number): void {
    this.increment("sqs_released", count);
  }

  count(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  private increment(key: string, by = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
}
