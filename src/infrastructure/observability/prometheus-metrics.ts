import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type {
  ApplicationMetrics,
  DuplicateType,
  LockConflict,
  Logger,
  TransactionSource,
  WagerProcessingObservation,
} from "../../application/ports/telemetry.ts";
import type { DeliveryDecision } from "../messaging/delivery-decision.ts";
import type { ConsumerMetrics } from "../messaging/wager-queue-consumer.ts";

/**
 * Prometheus exposition of one process (API replica or worker). Every series is a count, a
 * duration or a queue depth: no metric carries money, and labels are low-cardinality enums
 * (never walletId, providerId or other ids). Replicas are told apart by the scrape target and the
 * `instance` label of the default labels.
 */
export const METRIC_PREFIX = "wws_";

export function createMetricsRegistry(options: {
  readonly process: string;
  readonly instanceId: string;
  /** Process metrics (CPU, memory, event loop); off in tests that build many registries. */
  readonly defaultMetrics?: boolean;
}): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ process: options.process, instance: options.instanceId });
  if (options.defaultMetrics !== false) collectDefaultMetrics({ register: registry });
  return registry;
}

/** Seconds; from a fast uncontended request up to the transient retry budget. */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LOCK_WAIT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2];

/**
 * Retries of every component share one counter, labelled by component: the use case's transient
 * retries (transaction), SQS redeliveries (consumer), outbox publish backoffs (outbox) and
 * PENDING_REFERENCE re-checks still waiting (pending_reference).
 */
function retriesCounter(registry: Registry): Counter<"component" | "reason"> {
  const name = `${METRIC_PREFIX}retries_total`;
  const existing = registry.getSingleMetric(name);
  if (existing instanceof Counter) return existing;
  return new Counter({
    name,
    help: "Retries scheduled, by component and reason",
    labelNames: ["component", "reason"],
    registers: [registry],
  });
}

export class PrometheusApplicationMetrics implements ApplicationMetrics {
  private readonly retries: Counter<"component" | "reason">;
  private readonly lockConflicts: Counter<"reason">;
  private readonly lockWait: Histogram;
  private readonly duplicates: Counter<"type">;
  private readonly transactions: Counter<"kind" | "status" | "source">;
  private readonly processing: Histogram<"kind" | "source" | "outcome">;
  private readonly divergences: Counter;
  private readonly outboxPublishedTotal: Counter;
  private readonly outboxFailed: Counter<"reason">;
  private readonly outboxOldestAge: Gauge;
  private readonly outboxPending: Gauge;
  private readonly pendingChecks: Counter<"outcome">;

  constructor(registry: Registry) {
    const registers = [registry];
    this.retries = retriesCounter(registry);
    this.lockConflicts = new Counter({
      name: `${METRIC_PREFIX}lock_conflicts_total`,
      help: "Lock timeouts, deadlocks and serialization failures on the wallet row",
      labelNames: ["reason"],
      registers,
    });
    this.lockWait = new Histogram({
      name: `${METRIC_PREFIX}wallet_lock_wait_seconds`,
      help: "Time waiting for the wallet row lock (SELECT ... FOR UPDATE)",
      buckets: LOCK_WAIT_BUCKETS,
      registers,
    });
    this.duplicates = new Counter({
      name: `${METRIC_PREFIX}duplicates_total`,
      help: "Duplicates detected by the persistent idempotency, by type",
      labelNames: ["type"],
      registers,
    });
    this.transactions = new Counter({
      name: `${METRIC_PREFIX}wager_transactions_total`,
      help: "Wager transactions entering each status, by kind and source (replays excluded)",
      labelNames: ["kind", "status", "source"],
      registers,
    });
    this.processing = new Histogram({
      name: `${METRIC_PREFIX}wager_processing_duration_seconds`,
      help: "End-to-end processing latency of a wager transaction, transient retries included",
      labelNames: ["kind", "source", "outcome"],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.divergences = new Counter({
      name: `${METRIC_PREFIX}reconciliation_divergences_total`,
      help: "Reconciliations where the wallet balance differs from the ledger",
      registers,
    });
    this.outboxPublishedTotal = new Counter({
      name: `${METRIC_PREFIX}outbox_published_total`,
      help: "Outbox events published to SQS",
      registers,
    });
    this.outboxFailed = new Counter({
      name: `${METRIC_PREFIX}outbox_publish_failed_total`,
      help: "Outbox events SQS refused or did not confirm (retried with backoff)",
      labelNames: ["reason"],
      registers,
    });
    this.outboxOldestAge = new Gauge({
      name: `${METRIC_PREFIX}outbox_oldest_pending_age_seconds`,
      help: "Age of the oldest unpublished outbox event (0 when none)",
      registers,
    });
    this.outboxPending = new Gauge({
      name: `${METRIC_PREFIX}outbox_pending`,
      help: "Unpublished outbox events",
      registers,
    });
    this.pendingChecks = new Counter({
      name: `${METRIC_PREFIX}pending_reference_checks_total`,
      help: "PENDING_REFERENCE re-checks, by outcome",
      labelNames: ["outcome"],
      registers,
    });
  }

  transientRetry(reason: string): void {
    this.retries.inc({ component: "transaction", reason });
  }

  lockConflict(conflict: LockConflict): void {
    this.lockConflicts.inc({ reason: conflict });
  }

  walletLockWait(seconds: number): void {
    this.lockWait.observe(seconds);
  }

  duplicateDetected(type: DuplicateType): void {
    this.duplicates.inc({ type });
  }

  wagerTransactionDecided(kind: string, status: string, source: TransactionSource): void {
    this.transactions.inc({ kind, status, source });
  }

  wagerProcessed(observation: WagerProcessingObservation): void {
    this.processing.observe(
      { kind: observation.kind, source: observation.source, outcome: observation.outcome },
      observation.durationSeconds,
    );
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  outboxPublished(count: number): void {
    this.outboxPublishedTotal.inc(count);
  }

  outboxPublishFailed(reason: string): void {
    this.outboxFailed.inc({ reason });
    this.retries.inc({ component: "outbox", reason });
  }

  outboxLag(oldestPendingAgeMs: number, pendingCount: number): void {
    this.outboxOldestAge.set(oldestPendingAgeMs / 1000);
    this.outboxPending.set(pendingCount);
  }

  pendingReferenceChecked(outcome: string): void {
    this.pendingChecks.inc({ outcome });
    if (outcome === "PENDING_REFERENCE") {
      this.retries.inc({ component: "pending_reference", reason: "REFERENCE_NOT_READY" });
    }
  }
}

export class PrometheusConsumerMetrics implements ConsumerMetrics {
  private readonly receivedTotal: Counter;
  private readonly handledTotal: Counter<"action" | "outcome">;
  private readonly deleteFailedTotal: Counter;
  private readonly releasedTotal: Counter;
  private readonly dlqSent: Counter<"reason">;
  private readonly retries: Counter<"component" | "reason">;

  constructor(registry: Registry) {
    const registers = [registry];
    this.retries = retriesCounter(registry);
    this.receivedTotal = new Counter({
      name: `${METRIC_PREFIX}sqs_messages_received_total`,
      help: "Messages received from the wager queue",
      registers,
    });
    this.handledTotal = new Counter({
      name: `${METRIC_PREFIX}sqs_messages_handled_total`,
      help: "Messages handled, by action (ack, retry, dlq) and outcome",
      labelNames: ["action", "outcome"],
      registers,
    });
    this.deleteFailedTotal = new Counter({
      name: `${METRIC_PREFIX}sqs_delete_failed_total`,
      help: "Acks (DeleteMessage) that failed; the redelivery is replayed",
      registers,
    });
    this.releasedTotal = new Counter({
      name: `${METRIC_PREFIX}sqs_messages_released_total`,
      help: "Messages returned to the queue unprocessed on shutdown",
      registers,
    });
    this.dlqSent = new Counter({
      name: `${METRIC_PREFIX}sqs_dlq_sent_total`,
      help: "Messages this consumer sent to the DLQ, by failure code",
      labelNames: ["reason"],
      registers,
    });
  }

  received(count: number): void {
    this.receivedTotal.inc(count);
  }

  handled(action: DeliveryDecision["action"], outcome: string): void {
    this.handledTotal.inc({ action, outcome });
    if (action === "retry") this.retries.inc({ component: "consumer", reason: outcome });
    if (action === "dlq") this.dlqSent.inc({ reason: outcome });
  }

  deleteFailed(): void {
    this.deleteFailedTotal.inc();
  }

  released(count: number): void {
    this.releasedTotal.inc(count);
  }
}

/**
 * `wws_sqs_dlq_messages`: depth of the DLQ (ApproximateNumberOfMessages), read from SQS at scrape
 * time, with a short timeout. Queue-level, so every consumer replica reports the same value
 * (aggregate with max, not sum). When SQS does not answer, the series is left out of that scrape
 * instead of repeating a stale value.
 */
export function registerDlqDepthGauge(
  registry: Registry,
  options: {
    readonly sqs: SQSClient;
    readonly dlqUrl: string;
    readonly queueName: string;
    readonly timeoutMs: number;
    readonly logger: Logger;
  },
): void {
  new Gauge({
    name: `${METRIC_PREFIX}sqs_dlq_messages`,
    help: "Messages in the DLQ (ApproximateNumberOfMessages), read at scrape time",
    labelNames: ["queue"],
    registers: [registry],
    async collect() {
      this.reset();
      try {
        const { Attributes } = await options.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: options.dlqUrl,
            AttributeNames: ["ApproximateNumberOfMessages"],
          }),
          { abortSignal: AbortSignal.timeout(options.timeoutMs) },
        );
        const depth = Number(Attributes?.ApproximateNumberOfMessages);
        if (Number.isFinite(depth)) this.set({ queue: options.queueName }, depth);
      } catch (error) {
        options.logger.warn("dlq depth unavailable for this scrape", {
          queue: options.queueName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
