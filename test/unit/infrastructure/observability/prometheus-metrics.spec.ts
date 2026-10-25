import { describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  PrometheusApplicationMetrics,
  PrometheusConsumerMetrics,
  createMetricsRegistry,
  registerDlqDepthGauge,
} from "../../../../src/infrastructure/observability/prometheus-metrics.ts";
import { SilentLogger } from "../../../support/in-memory-telemetry.ts";

function exercised() {
  const registry = createMetricsRegistry({
    process: "test",
    instanceId: "test-1",
    defaultMetrics: false,
  });
  const app = new PrometheusApplicationMetrics(registry);
  const consumer = new PrometheusConsumerMetrics(registry);
  const sqs = { send: () => Promise.resolve({ Attributes: { ApproximateNumberOfMessages: "3" } }) };
  registerDlqDepthGauge(registry, {
    sqs: sqs as unknown as SQSClient,
    dlqUrl: "http://sqs/dlq",
    queueName: "wager-dlq",
    timeoutMs: 100,
    logger: new SilentLogger(),
  });
  app.wagerTransactionDecided("BET", "PROCESSED", "http");
  app.wagerProcessed({ kind: "BET", source: "http", outcome: "PROCESSED", durationSeconds: 0.02 });
  app.duplicateDetected("replay");
  app.transientRetry("55P03");
  app.lockConflict("lock_timeout");
  app.walletLockWait(0.001);
  app.outboxLag(1500, 4);
  app.outboxPublished(2);
  app.outboxPublishFailed("Throttled");
  app.pendingReferenceChecked("PENDING_REFERENCE");
  app.reconciliationDivergence();
  consumer.received(1);
  consumer.handled("retry", "TRANSIENT_FAILURE");
  consumer.handled("dlq", "INVALID_PAYLOAD");
  return registry;
}

describe("Prometheus metrics", () => {
  test("every metric section 12 requires is exposed", async () => {
    const text = await exercised().metrics();
    const required: readonly RegExp[] = [
      // transactions by status (and kind)
      /wws_wager_transactions_total\{kind="BET",status="PROCESSED",source="http",[^}]*\} 1/,
      // duplicates detected
      /wws_duplicates_total\{type="replay",[^}]*\} 1/,
      // retries, one counter for every component
      /wws_retries_total\{component="transaction",reason="55P03",[^}]*\} 1/,
      /wws_retries_total\{component="consumer",reason="TRANSIENT_FAILURE",[^}]*\} 1/,
      /wws_retries_total\{component="outbox",reason="Throttled",[^}]*\} 1/,
      /wws_retries_total\{component="pending_reference",[^}]*\} 1/,
      // messages in the DLQ (depth read from SQS at scrape time) and sent to it
      /wws_sqs_dlq_messages\{queue="wager-dlq",[^}]*\} 3/,
      /wws_sqs_dlq_sent_total\{reason="INVALID_PAYLOAD",[^}]*\} 1/,
      // lock conflicts and lock wait
      /wws_lock_conflicts_total\{reason="lock_timeout",[^}]*\} 1/,
      /wws_wallet_lock_wait_seconds_count\{[^}]*\} 1/,
      // outbox lag
      /wws_outbox_oldest_pending_age_seconds\{[^}]*\} 1\.5/,
      /wws_outbox_pending\{[^}]*\} 4/,
      // processing latency (histogram)
      /wws_wager_processing_duration_seconds_bucket\{le="0\.025",[^}]*kind="BET",source="http",outcome="PROCESSED"\} 1/,
      // reconciliation divergences
      /wws_reconciliation_divergences_total\{[^}]*\} 1/,
    ];
    for (const pattern of required) expect(text).toMatch(pattern);
  });

  test("no metric name or label carries money or a high-cardinality id", async () => {
    const metrics = await exercised().getMetricsAsJSON();
    const forbidden = /amount|balance|money|wallet_?id|provider_?id|player|transaction_?id/i;
    for (const metric of metrics) {
      expect(metric.name).not.toMatch(/amount|balance|money/i);
      for (const value of metric.values) {
        for (const label of Object.keys(value.labels)) expect(label).not.toMatch(forbidden);
      }
    }
  });

  test("an unreachable SQS leaves the DLQ series out of the scrape instead of a stale value", async () => {
    const registry = createMetricsRegistry({
      process: "t",
      instanceId: "t",
      defaultMetrics: false,
    });
    let up = true;
    const sqs = {
      send: () =>
        up
          ? Promise.resolve({ Attributes: { ApproximateNumberOfMessages: "5" } })
          : Promise.reject(new Error("unreachable")),
    };
    registerDlqDepthGauge(registry, {
      sqs: sqs as unknown as SQSClient,
      dlqUrl: "http://sqs/dlq",
      queueName: "wager-dlq",
      timeoutMs: 100,
      logger: new SilentLogger(),
    });
    expect(await registry.metrics()).toMatch(/wws_sqs_dlq_messages\{[^}]*\} 5/);
    up = false;
    expect(await registry.metrics()).not.toMatch(/wws_sqs_dlq_messages\{/);
  });
});
