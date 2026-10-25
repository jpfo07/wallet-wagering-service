import { afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { WAGER_CONSUMER_NAME } from "../../../src/infrastructure/messaging/wager-queue-consumer.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import {
  createWallet,
  inboxRow,
  ledgerRows,
  outboxEventTypes,
  transactionRows,
  wagerCommand,
  walletState,
} from "../../support/command-builders.ts";
import {
  isQueueEmpty,
  queueCounts,
  sendCommand,
  sendRaw,
  wagerEnvelope,
} from "../../support/consumer-support.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { holdWalletLock, lockWaiters } from "../../support/lock-barrier.ts";
import { waitFor } from "../../support/polling.ts";
import { CRASH_POINT_MARKER, freePort, spawnScript } from "../../support/processes.ts";
import type { ChildProcess } from "../../support/processes.ts";
import { createIsolatedQueues, testSqsClient } from "../../support/queues.ts";
import type { IsolatedQueues } from "../../support/queues.ts";
import { childProcessEnv } from "../../support/test-env.ts";

const CONSUMER_ENTRYPOINT = "src/entrypoints/sqs-consumer.ts";
const CRASHING_CONSUMER = "test/support/processes/consumer-crash-before-ack.ts";

/**
 * Separate Bun processes, as separate instances would be: each has its own pool, its own SQS client
 * and its own consumer loop. Only PostgreSQL and the queue are shared.
 */
describe("SQS consumer as separate processes (real LocalStack and PostgreSQL)", () => {
  const suite = useApplicationSuite("concurrency-sqs-processes");
  const sqs = testSqsClient();
  const children: ChildProcess[] = [];
  const queueSets: IsolatedQueues[] = [];

  afterAll(async () => {
    for (const child of children) child.kill();
    for (const queues of queueSets) await queues.delete();
    sqs.destroy();
  });

  async function isolatedQueues(name: string, visibilityTimeoutSeconds?: number) {
    const queues = await createIsolatedQueues(
      name,
      visibilityTimeoutSeconds === undefined ? {} : { visibilityTimeoutSeconds },
    );
    queueSets.push(queues);
    return queues;
  }

  function spawnConsumer(
    script: string,
    queues: IsolatedQueues,
    instance: string,
    extra: Record<string, string> = {},
  ): ChildProcess {
    const child = spawnScript(
      script,
      childProcessEnv(suite().db.config, {
        INSTANCE_ID: instance,
        WORKER_HEALTH_PORT: String(freePort()),
        SQS_WAGER_QUEUE_NAME: queues.wagerQueueName,
        SQS_WAGER_DLQ_NAME: queues.dlqName,
        SQS_EVENTS_QUEUE_NAME: queues.eventsQueueName,
        SQS_WAIT_TIME_SECONDS: "1",
        SQS_RETRY_BACKOFF_BASE_MS: "1000",
        SQS_RETRY_BACKOFF_MAX_MS: "2000",
        DATABASE_TRANSIENT_RETRY_BASE_MS: "10",
        DATABASE_TRANSIENT_RETRY_MAX_MS: "40",
        ...extra,
      }),
    );
    children.push(child);
    return child;
  }

  const wagers = async (sql: SQL, walletId: string) =>
    (await transactionRows(sql, walletId)).filter((row) => row.kind !== "OPENING");

  test("process killed after the commit and before the ack: the redelivery is a replay, one effect", async () => {
    const { sql } = suite();
    // Short visibility so the redelivery comes quickly; the budget fits with a 200 ms lock_timeout.
    const queues = await isolatedQueues("crash-before-ack", 3);
    const fastBudget = { DATABASE_LOCK_TIMEOUT_MS: "200", SQS_PROCESSING_MARGIN_MS: "500" };
    const wallet = await createWallet(suite().app, "100.00");
    const { messageId } = await sendCommand(
      sqs,
      queues.wagerQueueUrl,
      wagerCommand(wallet, "BET", { amount: "30.00" }),
    );

    const crashing = spawnConsumer(CRASHING_CONSUMER, queues, "crashing", fastBudget);
    await crashing.waitForOutput(CRASH_POINT_MARKER);
    // Committed: transaction, ledger, outbox and inbox are there…
    expect(await wagers(sql, wallet.id)).toHaveLength(1);
    expect(await inboxRow(sql, WAGER_CONSUMER_NAME, messageId)).toEqual({ processed: true });
    expect((await walletState(sql, wallet.id)).balance).toBe("70.00");
    // …and the message was never acknowledged.
    crashing.child.kill("SIGKILL");
    await crashing.exited(10_000);
    expect(await queueCounts(sqs, queues.wagerQueueUrl)).toEqual({ visible: 0, inFlight: 1 });

    const recovery = spawnConsumer(CONSUMER_ENTRYPOINT, queues, "recovery", fastBudget);
    await waitFor(() => isQueueEmpty(sqs, queues.wagerQueueUrl), {
      timeoutMs: 20_000,
      description: "the redelivered message to be acknowledged",
    });
    expect(recovery.output()).toContain('"idempotentReplay":true');
    expect(recovery.output()).toContain('"receiveCount":2');
    expect(await isQueueEmpty(sqs, queues.dlqUrl)).toBe(true);
    expect(await wagers(sql, wallet.id)).toHaveLength(1);
    expect(await ledgerRows(sql, wallet.id)).toHaveLength(2);
    expect(await outboxEventTypes(sql, wallet.id)).toHaveLength(4); // OPENING ×2 + BET ×2
    expect((await walletState(sql, wallet.id)).balance).toBe("70.00");
    recovery.child.kill("SIGTERM");
    expect(await recovery.exited(15_000)).toBe(0);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("SIGTERM with a message in flight: exits 0 and gives the message back at once", async () => {
    const { sql } = suite();
    const queues = await isolatedQueues("sigterm"); // 60 s visibility
    const wallet = await createWallet(suite().app, "100.00");
    const consumer = spawnConsumer(CONSUMER_ENTRYPOINT, queues, "sigterm", {
      SQS_SHUTDOWN_DRAIN_MS: "500",
    });
    await consumer.waitForOutput("sqs consumer started");

    const lock = await holdWalletLock(sql, wallet.id);
    try {
      await sendCommand(sqs, queues.wagerQueueUrl, wagerCommand(wallet, "BET", { amount: "4.00" }));
      await waitFor(async () => (await lockWaiters(sql)) >= 1, {
        description: "the consumer process blocked on the wallet lock",
      });
      consumer.child.kill("SIGTERM");
      expect(await consumer.exited(15_000)).toBe(0);
      expect(consumer.output()).toContain('"released":1');
      // Visible again right away, long before the 60 s VisibilityTimeout.
      await waitFor(async () => (await queueCounts(sqs, queues.wagerQueueUrl)).visible === 1, {
        timeoutMs: 5_000,
        description: "the message to be visible again",
      });
      expect(await wagers(sql, wallet.id)).toHaveLength(0);
    } finally {
      await lock.release();
    }

    const next = spawnConsumer(CONSUMER_ENTRYPOINT, queues, "sigterm-next");
    await waitFor(() => isQueueEmpty(sqs, queues.wagerQueueUrl), {
      timeoutMs: 20_000,
      description: "the message processed by the next instance",
    });
    expect(await wagers(sql, wallet.id)).toHaveLength(1);
    expect((await walletState(sql, wallet.id)).balance).toBe("96.00");
    next.child.kill("SIGTERM");
    expect(await next.exited(15_000)).toBe(0);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("3 consumer processes on one queue, every message delivered twice: each wager applied once", async () => {
    const { sql } = suite();
    const queues = await isolatedQueues("three-consumers");
    const WALLETS = 6;
    const BETS = 8;
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () => createWallet(suite().app, "100.00")),
    );
    const consumers = ["a", "b", "c"].map((name) =>
      spawnConsumer(CONSUMER_ENTRYPOINT, queues, `multi-${name}`),
    );
    await Promise.all(consumers.map((consumer) => consumer.waitForOutput("sqs consumer started")));

    for (const wallet of wallets) {
      for (let i = 0; i < BETS; i += 1) {
        const envelope = wagerEnvelope(wagerCommand(wallet, "BET", { amount: "1.25" }));
        // The same message twice (new SQS send each time): the inbox must absorb the copy.
        await sendRaw(sqs, queues.wagerQueueUrl, envelope.body, wallet.id);
        await sendRaw(sqs, queues.wagerQueueUrl, envelope.body, wallet.id);
      }
    }

    await waitFor(() => isQueueEmpty(sqs, queues.wagerQueueUrl), {
      timeoutMs: 60_000,
      description: `${WALLETS * BETS * 2} messages consumed by 3 processes`,
    });
    for (const consumer of consumers) consumer.child.kill("SIGTERM");
    for (const consumer of consumers) expect(await consumer.exited(15_000)).toBe(0);

    expect(await isQueueEmpty(sqs, queues.dlqUrl)).toBe(true);
    for (const wallet of wallets) {
      expect(await wagers(sql, wallet.id)).toHaveLength(BETS);
      expect((await walletState(sql, wallet.id)).balance).toBe("90.00");
      expect(await ledgerRows(sql, wallet.id)).toHaveLength(BETS + 1);
      await assertLedgerInvariant(sql, wallet.id);
    }
  });
});
