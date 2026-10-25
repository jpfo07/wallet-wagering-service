import type {
  ApplicationMetrics,
  DuplicateType,
  LockConflict,
  Logger,
  TransactionSource,
  WagerProcessingObservation,
} from "../../src/application/ports/telemetry.ts";
import type { DeliveryDecision } from "../../src/infrastructure/messaging/delivery-decision.ts";
import type { ConsumerMetrics } from "../../src/infrastructure/messaging/wager-queue-consumer.ts";

export class SilentLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

export type ApplicationMetricName =
  | "transient_retry"
  | "lock_conflict"
  | "wallet_lock_wait"
  | "duplicate"
  | "wager_transaction"
  | "wager_processed"
  | "reconciliation_divergence"
  | "outbox_published"
  | "outbox_publish_failed"
  | "pending_reference_checked";

export type ApplicationGaugeName = "outbox_oldest_pending_age_ms" | "outbox_pending";

/**
 * Test double of the metrics ports: plain counters that a test can read back with `count()`.
 * Production uses the Prometheus adapters (prometheus-metrics.ts).
 */
export class InMemoryApplicationMetrics implements ApplicationMetrics {
  private readonly counters = new Map<string, number>();

  transientRetry(reason: string): void {
    this.increment(`transient_retry{reason=${reason}}`);
    this.increment("transient_retry");
  }

  lockConflict(conflict: LockConflict): void {
    this.increment(`lock_conflict{reason=${conflict}}`);
    this.increment("lock_conflict");
  }

  walletLockWait(): void {
    this.increment("wallet_lock_wait");
  }

  duplicateDetected(type: DuplicateType): void {
    this.increment(`duplicate{type=${type}}`);
    this.increment("duplicate");
  }

  wagerTransactionDecided(kind: string, status: string, source: TransactionSource): void {
    this.increment(`wager_transaction{kind=${kind},status=${status},source=${source}}`);
    this.increment(`wager_transaction{status=${status}}`);
    this.increment("wager_transaction");
  }

  wagerProcessed(observation: WagerProcessingObservation): void {
    this.increment(`wager_processed{outcome=${observation.outcome}}`);
    this.increment("wager_processed");
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

/** Test double of the consumer metrics. */
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
