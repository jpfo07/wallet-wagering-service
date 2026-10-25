import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { WagerTransactionStatus as Status } from "../../../src/domain/wager/wager-transaction-status.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import { CTX, createWallet, wagerCommand } from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { waitFor } from "../../support/polling.ts";
import { OUTBOX_CRASH_MARKER, freePort, spawnScript } from "../../support/processes.ts";
import type { ChildProcess } from "../../support/processes.ts";
import { createIsolatedQueues, testSqsClient } from "../../support/queues.ts";
import type { IsolatedQueues } from "../../support/queues.ts";
import { childProcessEnv } from "../../support/test-env.ts";
import {
  drainEvents,
  outboxOrderByAggregate,
  outboxRows,
  pendingOutboxCount,
  receivedOrderByAggregate,
} from "../../support/worker-support.ts";

const PUBLISHER_ENTRYPOINT = "src/entrypoints/outbox-publisher.ts";
const PENDING_WORKER_ENTRYPOINT = "src/entrypoints/pending-reference-worker.ts";
const CRASHING_PUBLISHER = "test/support/processes/outbox-publisher-crash.ts";

/**
 * Publishers and the pending-reference worker as separate Bun processes, as separate instances
 * would be: their own pools and SQS clients; only PostgreSQL and the queue are shared.
 */
describe("outbox publisher and pending-reference worker as processes", () => {
  const suite = useApplicationSuite("concurrency-worker-processes");
  const sqs = testSqsClient();
  const children: ChildProcess[] = [];
  const queueSets: IsolatedQueues[] = [];

  afterAll(async () => {
    for (const child of children) child.kill();
    for (const queues of queueSets) await queues.delete();
    sqs.destroy();
  });

  beforeEach(async () => {
    await discardPending(suite().sql);
  });

  async function eventsQueue(name: string): Promise<IsolatedQueues> {
    const queues = await createIsolatedQueues(name);
    queueSets.push(queues);
    return queues;
  }

  function spawnWorker(
    script: string,
    queues: IsolatedQueues | undefined,
    instance: string,
    extra: Record<string, string> = {},
  ): ChildProcess {
    const child = spawnScript(
      script,
      childProcessEnv(suite().db.config, {
        INSTANCE_ID: instance,
        WORKER_HEALTH_PORT: String(freePort()),
        ...(queues === undefined
          ? {}
          : {
              SQS_WAGER_QUEUE_NAME: queues.wagerQueueName,
              SQS_WAGER_DLQ_NAME: queues.dlqName,
              SQS_EVENTS_QUEUE_NAME: queues.eventsQueueName,
            }),
        OUTBOX_POLL_INTERVAL_MS: "20",
        PENDING_REFERENCE_POLL_INTERVAL_MS: "20",
        DATABASE_TRANSIENT_RETRY_BASE_MS: "10",
        DATABASE_TRANSIENT_RETRY_MAX_MS: "40",
        ...extra,
      }),
    );
    children.push(child);
    return child;
  }

  async function sigterm(child: ChildProcess): Promise<number | "timeout"> {
    child.child.kill("SIGTERM");
    return child.exited(15_000);
  }

  test("3 publishers, events committed while they run: everything published once, in order per wallet", async () => {
    const { app, sql } = suite();
    const queues = await eventsQueue("proc-publishers");
    // Small batches so the publishers keep interleaving over the same wallets.
    const publishers = [1, 2, 3].map((n) =>
      spawnWorker(PUBLISHER_ENTRYPOINT, queues, `publisher-${n}`, {
        OUTBOX_BATCH_AGGREGATES: "2",
        OUTBOX_MAX_EVENTS_PER_AGGREGATE: "2",
      }),
    );
    await Promise.all(publishers.map((child) => child.waitForOutput("outbox publisher started")));

    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(app, "100.00")));
    await Promise.all(
      wallets.map(async (wallet) => {
        for (let i = 0; i < 5; i += 1) {
          await app.processWagerTransaction.execute(wagerCommand(wallet, "BET"), CTX);
        }
      }),
    );
    const expected = wallets.length * 2 + wallets.length * 5 * 2;
    await waitFor(async () => (await pendingOutboxCount(sql)) === 0, {
      timeoutMs: 30_000,
      description: "outbox drained by 3 publishers",
    });

    const received = await drainEvents(sqs, queues.eventsQueueUrl, expected);
    const rows = (await outboxRows(sql)).filter((row) =>
      wallets.some((wallet) => wallet.id === row.aggregate_id),
    );
    expect(rows).toHaveLength(expected);
    expect(new Set(received.map((event) => event.eventId)).size).toBe(received.length);
    expect(new Set(received.map((event) => event.eventId))).toEqual(
      new Set(rows.map((row) => row.id)),
    );
    expect(receivedOrderByAggregate(received)).toEqual(outboxOrderByAggregate(rows));

    // SIGTERM: each publisher finishes its batch and exits cleanly.
    for (const publisher of publishers) expect(await sigterm(publisher)).toBe(0);
    for (const wallet of wallets) await assertLedgerInvariant(sql, wallet.id);
  });

  test("killed after the COMMIT and before publishing: another process publishes the events", async () => {
    const { app, sql } = suite();
    const queues = await eventsQueue("proc-crash-before");
    const wallet = await createWallet(app, "100.00");
    await app.processWagerTransaction.execute(wagerCommand(wallet, "BET"), CTX);
    const committed = await outboxRows(sql, wallet.id);
    expect(committed).toHaveLength(4);

    const crashing = spawnWorker(CRASHING_PUBLISHER, queues, "publisher-crash", {
      OUTBOX_CRASH_MODE: "before-send",
    });
    await crashing.waitForOutput(OUTBOX_CRASH_MARKER);
    crashing.kill();
    await crashing.exited(10_000);
    // Its transaction died with it: still pending, untouched, and unlocked.
    expect(
      (await outboxRows(sql, wallet.id)).map((row) => [row.attempts, row.published_at]),
    ).toEqual(committed.map(() => [0, null]));

    const survivor = spawnWorker(PUBLISHER_ENTRYPOINT, queues, "publisher-survivor");
    await waitFor(async () => (await pendingOutboxCount(sql)) === 0, {
      timeoutMs: 20_000,
      description: "events published by the surviving process",
    });
    const received = await drainEvents(sqs, queues.eventsQueueUrl, committed.length);
    expect(received.map((event) => event.eventId)).toEqual(committed.map((row) => row.id));
    expect(await sigterm(survivor)).toBe(0);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("killed after SQS accepted and before marking: the republication is deduplicated", async () => {
    const { app, sql } = suite();
    const queues = await eventsQueue("proc-crash-after");
    const wallet = await createWallet(app, "100.00");
    const committed = await outboxRows(sql, wallet.id);

    const crashing = spawnWorker(CRASHING_PUBLISHER, queues, "publisher-crash", {
      OUTBOX_CRASH_MODE: "after-send",
    });
    await crashing.waitForOutput(OUTBOX_CRASH_MARKER);
    crashing.kill();
    await crashing.exited(10_000);
    // SQS has the head; the outbox still says pending (the mark was never committed).
    expect((await outboxRows(sql, wallet.id)).every((row) => row.published_at === null)).toBe(true);

    const survivor = spawnWorker(PUBLISHER_ENTRYPOINT, queues, "publisher-survivor");
    await waitFor(async () => (await pendingOutboxCount(sql)) === 0, {
      timeoutMs: 20_000,
      description: "events republished by the surviving process",
    });
    // Published at least once each, the head twice by us, delivered once (MessageDeduplicationId).
    const received = await drainEvents(sqs, queues.eventsQueueUrl, committed.length, {
      settleMs: 3_000,
    });
    expect(received.map((event) => event.eventId)).toEqual(committed.map((row) => row.id));
    expect(await sigterm(survivor)).toBe(0);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("the pending-reference worker process resolves a REFUND when its BET arrives, and exits on SIGTERM", async () => {
    const { app, sql } = suite();
    const queues = await eventsQueue("proc-pending");
    const worker = spawnWorker(PENDING_WORKER_ENTRYPOINT, queues, "pending-1", {
      PENDING_REFERENCE_BACKOFF_BASE_MS: "600000",
      PENDING_REFERENCE_BACKOFF_MAX_MS: "600000",
    });
    await worker.waitForOutput("pending reference worker started");

    const wallet = await createWallet(app, "100.00");
    const refund = await app.processWagerTransaction.execute(
      wagerCommand(wallet, "REFUND", { amount: "40.00", reference: "bet-proc" }),
      CTX,
    );
    await app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-proc", amount: "40.00" }),
      CTX,
    );
    await waitFor(
      async () =>
        (await app.getTransaction.execute(refund.transactionId)).status === Status.Processed,
      { timeoutMs: 15_000, description: "REFUND resolved by the worker process" },
    );
    expect((await app.getWallet.execute(wallet.id)).balance).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
    expect(await sigterm(worker)).toBe(0);
    await assertLedgerInvariant(sql, wallet.id);
  });
});

/** Test-only: leaves no pending event from an earlier test of the same database. */
async function discardPending(sql: SQL): Promise<void> {
  await sql.unsafe(
    `update outbox_messages set published_at = now(), next_attempt_at = null
      where published_at is null`,
  );
}
