import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { PinoLogger } from "../../../src/infrastructure/observability/pino-logger.ts";
import { createMetricsRegistry } from "../../../src/infrastructure/observability/prometheus-metrics.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import { createWallet, wagerCommand } from "../../support/command-builders.ts";
import { sendRaw, startTestConsumer, wagerEnvelope } from "../../support/consumer-support.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { LogCapture } from "../../support/log-capture.ts";
import { waitFor } from "../../support/polling.ts";
import { createIsolatedQueues, testSqsClient } from "../../support/queues.ts";

describe("SQS consumer — logs and DLQ depth (real LocalStack and PostgreSQL)", () => {
  const suite = useApplicationSuite("consumer-observability");
  let sqs: SQSClient;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(() => {
    sqs = testSqsClient();
  });

  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    sqs.destroy();
  });

  test("the use case's log carries messageId and the message correlationId; the DLQ depth is exposed", async () => {
    const logs = new LogCapture();
    const handle = await suite().open({
      dependencies: () => ({
        logger: PinoLogger.create({
          base: { process: "sqs-consumer", instanceId: "test" },
          destination: logs,
        }),
      }),
    });
    const queues = await createIsolatedQueues("consumer-obs");
    cleanups.push(() => queues.delete());
    const registry = createMetricsRegistry({
      process: "sqs-consumer",
      instanceId: "test",
      defaultMetrics: false,
    });
    const consumer = await startTestConsumer({
      sqs,
      queues,
      handle,
      database: suite().db.config,
      metricsRegistry: registry,
    });
    cleanups.push(() => consumer.stop());

    const wallet = await createWallet(handle.app, "100.00");
    const command = wagerCommand(wallet, "BET", { amount: "12.34" });
    const envelope = wagerEnvelope(command);
    await sendRaw(sqs, queues.wagerQueueUrl, envelope.body, wallet.id, {
      correlationId: "corr-from-producer",
    });
    await sendRaw(sqs, queues.wagerQueueUrl, "{not json", "malformed");

    const handled = await waitFor(
      () => logs.find("wager transaction handled", (l) => l["messageId"] === envelope.messageId),
      { description: "the use case log of the message" },
    );
    expect(handled).toMatchObject({
      correlationId: "corr-from-producer",
      messageId: envelope.messageId,
      walletId: wallet.id,
      providerId: command.providerId,
    });
    expect(typeof handled["transactionId"]).toBe("string");
    expect(logs.text()).not.toContain("12.34");

    // ApproximateNumberOfMessages is eventually consistent: poll the scrape.
    await waitFor(
      async () => /wws_sqs_dlq_messages\{queue="[^"]+",[^}]*\} 1/.test(await registry.metrics()),
      { description: "DLQ depth 1 on /metrics" },
    );
    expect(consumer.metrics.count("sqs_handled{action=dlq}")).toBe(1);
    await assertLedgerInvariant(suite().sql, wallet.id);
  });
});
