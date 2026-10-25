import { afterAll, describe, expect, test } from "bun:test";
import { useApplicationSuite } from "../../support/application-suite.ts";
import {
  createWallet,
  ledgerRows,
  wagerCommand,
  walletState,
} from "../../support/command-builders.ts";
import {
  isQueueEmpty,
  queueCounts,
  sendCommand,
  startTestConsumer,
} from "../../support/consumer-support.ts";
import { pauseTestPostgres } from "../../support/docker.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { waitFor } from "../../support/polling.ts";
import { createIsolatedQueues, testSqsClient } from "../../support/queues.ts";

describe("SQS consumer during a PostgreSQL outage (docker pause)", () => {
  const suite = useApplicationSuite("sqs-consumer-outage");
  const sqs = testSqsClient();

  afterAll(() => {
    sqs.destroy();
  });

  test("stops fetching while the database is down; the message keeps its receives and is processed once after", async () => {
    const { sql } = suite();
    const queues = await createIsolatedQueues("consumer-outage");
    const consumer = await startTestConsumer({
      sqs,
      queues,
      handle: suite(),
      database: suite().db.config,
    });
    try {
      const wallet = await createWallet(suite().app, "100.00");
      const unpause = pauseTestPostgres();
      try {
        await waitFor(() => !consumer.gate.isOpen, {
          timeoutMs: 10_000,
          description: "the consumer to notice the database is down",
        });
        await sendCommand(
          sqs,
          queues.wagerQueueUrl,
          wagerCommand(wallet, "BET", { amount: "12.00" }),
        );
        // Several probe rounds pass with the message sitting in the queue, never received.
        const failedBefore = consumer.gate.failedProbeCount;
        await waitFor(() => consumer.gate.failedProbeCount >= failedBefore + 3, {
          timeoutMs: 10_000,
          description: "three more failed probes",
        });
        expect(await queueCounts(sqs, queues.wagerQueueUrl)).toEqual({ visible: 1, inFlight: 0 });
        expect(consumer.metrics.count("sqs_received")).toBe(0);
      } finally {
        unpause();
      }

      await waitFor(() => consumer.metrics.count("sqs_handled{action=ack}") === 1, {
        timeoutMs: 20_000,
        description: "the BET to be processed after the database is back",
      });
      const [ack] = consumer.logger.find("sqs message acknowledged");
      expect(ack?.fields["receiveCount"]).toBe(1);
      expect(ack?.fields["outcome"]).toBe("PROCESSED");
      expect(consumer.logger.find("database reachable again, resuming receive")).toHaveLength(1);
      expect(await isQueueEmpty(sqs, queues.wagerQueueUrl)).toBe(true);
      expect(await isQueueEmpty(sqs, queues.dlqUrl)).toBe(true);
      expect((await walletState(sql, wallet.id)).balance).toBe("88.00");
      expect(await ledgerRows(sql, wallet.id)).toHaveLength(2);
      await assertLedgerInvariant(sql, wallet.id);
    } finally {
      await consumer.stop();
      await queues.delete();
    }
  });
});
