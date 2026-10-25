import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { ConfigError } from "../../../src/infrastructure/config/env.ts";
import { startOutboxPublisher } from "../../../src/infrastructure/workers/start-outbox-publisher.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import { CTX, createWallet, wagerCommand } from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { waitFor } from "../../support/polling.ts";
import { createIsolatedQueues, testSqsClient } from "../../support/queues.ts";
import type { IsolatedQueues } from "../../support/queues.ts";
import { TEST_OUTBOX_PUBLISHER, testDatabaseConfig } from "../../support/test-env.ts";
import {
  ManualClock,
  RefusingPublisher,
  drainEvents,
  outboxOrderByAggregate,
  outboxPublisherFor,
  outboxRows,
  pendingOutboxCount,
  receivedOrderByAggregate,
  sqsPublisher,
} from "../../support/worker-support.ts";

/**
 * The publisher in-process against real PostgreSQL and LocalStack. Each test has its own events
 * queue; events left pending by an earlier test of the suite are discarded first, so a batch only
 * sees what the test created.
 */
describe("outbox publisher (real PostgreSQL and LocalStack)", () => {
  const suite = useApplicationSuite("workers-outbox");
  const sqs = testSqsClient();
  const queueSets: IsolatedQueues[] = [];

  afterAll(async () => {
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

  async function withClock(clock: ManualClock) {
    return suite().open({ dependencies: () => ({ clock }) });
  }

  test("publishes with MessageGroupId = walletId and MessageDeduplicationId = eventId, then marks published", async () => {
    const { app, sql } = suite();
    const queues = await eventsQueue("outbox-basic");
    const wallet = await createWallet(app, "100.00");
    await app.processWagerTransaction.execute(wagerCommand(wallet, "BET"), CTX);
    const pending = await outboxRows(sql, wallet.id);
    expect(pending.map((row) => row.event_type)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    const publish = outboxPublisherFor(app, sqsPublisher(sqs, queues.eventsQueueUrl));
    expect(await publish.execute()).toEqual({ claimed: 4, published: 4, failed: 0 });

    const received = await drainEvents(sqs, queues.eventsQueueUrl, 4);
    expect(received.map((event) => event.eventId)).toEqual(pending.map((row) => row.id));
    for (const event of received) {
      expect(event.groupId).toBe(wallet.id);
      expect(event.deduplicationId).toBe(event.eventId);
      expect(event.eventTypeAttribute).toBe(event.eventType);
      expect(event.body["correlationId"]).toBe(CTX.correlationId);
    }
    const published = await outboxRows(sql, wallet.id);
    expect(
      published.every((row) => row.published_at !== null && row.next_attempt_at === null),
    ).toBe(true);
    expect(await publish.execute()).toEqual({ claimed: 0, published: 0, failed: 0 });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("a real SQS failure schedules a retry with backoff; the outbox never gives up", async () => {
    const { sql } = suite();
    const queues = await eventsQueue("outbox-retry");
    const clock = new ManualClock();
    const handle = await withClock(clock);
    const wallet = await createWallet(handle.app, "50.00");
    const rows = await outboxRows(sql, wallet.id);
    const [head] = rows;

    // A queue that does not exist: SQS itself refuses the request.
    const broken = outboxPublisherFor(
      handle.app,
      sqsPublisher(sqs, `${queues.eventsQueueUrl}-missing`),
    );
    expect(await broken.execute()).toEqual({ claimed: 2, published: 0, failed: 1 });
    const afterFailure = await outboxRows(sql, wallet.id);
    expect(afterFailure.map((row) => row.attempts)).toEqual([1, 0]);
    const delay = (afterFailure[0]?.next_attempt_at?.getTime() ?? 0) - clock.now().getTime();
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1_000);
    expect(handle.metrics.count("outbox_publish_failed")).toBe(1);

    // Not due yet: nothing is claimed, the second event waits behind its head.
    expect(await broken.execute()).toEqual({ claimed: 0, published: 0, failed: 0 });

    // After many failures the event is still pending and still claimable, with a capped delay.
    await sql.unsafe("update outbox_messages set attempts = 40 where id = $1", [head?.id]);
    clock.advance(1_000);
    expect(await broken.execute()).toMatchObject({ failed: 1 });
    const capped = await outboxRows(sql, wallet.id);
    expect(capped[0]?.attempts).toBe(41);
    expect(capped[0]?.published_at).toBeNull();
    expect(
      (capped[0]?.next_attempt_at?.getTime() ?? 0) - clock.now().getTime(),
    ).toBeLessThanOrEqual(60_000);

    // SQS back: both are published, in order.
    clock.advance(60_000);
    const healthy = outboxPublisherFor(handle.app, sqsPublisher(sqs, queues.eventsQueueUrl));
    expect(await healthy.execute()).toEqual({ claimed: 2, published: 2, failed: 0 });
    const received = await drainEvents(sqs, queues.eventsQueueUrl, 2);
    expect(received.map((event) => event.eventId)).toEqual(rows.map((row) => row.id));
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("a head waiting for its retry holds back its own wallet only", async () => {
    const { sql } = suite();
    const queues = await eventsQueue("outbox-hol");
    const clock = new ManualClock();
    const handle = await withClock(clock);
    const a = await createWallet(handle.app, "30.00");
    const b = await createWallet(handle.app, "40.00");
    const [aHead] = await outboxRows(sql, a.id);
    const refusing = new RefusingPublisher(
      sqsPublisher(sqs, queues.eventsQueueUrl),
      new Set([aHead?.id ?? ""]),
    );
    const publish = outboxPublisherFor(handle.app, refusing);

    expect(await publish.execute()).toEqual({ claimed: 4, published: 2, failed: 1 });
    expect((await outboxRows(sql, b.id)).every((row) => row.published_at !== null)).toBe(true);
    expect((await outboxRows(sql, a.id)).map((row) => row.published_at)).toEqual([null, null]);

    refusing.refused.clear();
    expect(await publish.execute()).toEqual({ claimed: 0, published: 0, failed: 0 });
    clock.advance(1_000);
    expect(await publish.execute()).toEqual({ claimed: 2, published: 2, failed: 0 });

    const received = await drainEvents(sqs, queues.eventsQueueUrl, 4);
    const rows = await outboxRows(sql);
    expect(receivedOrderByAggregate(received)).toEqual(
      outboxOrderByAggregate(rows.filter((row) => [a.id, b.id].includes(row.aggregate_id))),
    );
    await assertLedgerInvariant(sql, a.id);
    await assertLedgerInvariant(sql, b.id);
  });

  test("a head locked by another publisher is skipped, and the rest of its wallet with it", async () => {
    const { app, sql } = suite();
    const queues = await eventsQueue("outbox-skip");
    const a = await createWallet(app, "100.00");
    await app.processWagerTransaction.execute(wagerCommand(a, "BET"), CTX);
    const b = await createWallet(app, "100.00");
    const aRows = await outboxRows(sql, a.id);
    const publish = outboxPublisherFor(app, sqsPublisher(sqs, queues.eventsQueueUrl));

    // "Another publisher" holds the head of wallet A.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const holder = sql.begin(async (tx) => {
      await tx.unsafe("select id from outbox_messages where id = $1 for update", [aRows[0]?.id]);
      held();
      await released;
    });
    await isHeld;

    expect(await publish.execute()).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect((await outboxRows(sql, a.id)).every((row) => row.published_at === null)).toBe(true);

    release();
    await holder;
    expect(await publish.execute()).toEqual({ claimed: 4, published: 4, failed: 0 });
    const received = await drainEvents(sqs, queues.eventsQueueUrl, 6);
    expect(receivedOrderByAggregate(received).get(a.id)).toEqual(aRows.map((row) => row.id));
    expect(receivedOrderByAggregate(received).get(b.id)).toHaveLength(2);
    await assertLedgerInvariant(sql, a.id);
    await assertLedgerInvariant(sql, b.id);
  });

  test("order inside a wallet follows the commit order (sequence), not occurred_at", async () => {
    const { sql } = suite();
    const queues = await eventsQueue("outbox-skew");
    const clock = new ManualClock();
    const handle = await withClock(clock);
    const wallet = await createWallet(handle.app, "100.00");
    const first = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET"),
      CTX,
    );
    // The next transaction runs on an "instance" whose clock is 2 s behind.
    clock.advance(-2_000);
    const second = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET"),
      CTX,
    );
    const occurred: { transaction_id: string; occurred_at: Date }[] = await sql.unsafe(
      `select payload->'data'->>'transactionId' as transaction_id, occurred_at
         from outbox_messages where aggregate_id = $1 and event_type = 'WagerTransactionProcessed'
          and payload->'data'->>'kind' = 'BET'`,
      [wallet.id],
    );
    const at = (id: string) =>
      occurred.find((row) => row.transaction_id === id)?.occurred_at.getTime() ?? 0;
    expect(at(second.transactionId)).toBeLessThan(at(first.transactionId));

    clock.advance(10_000);
    const publish = outboxPublisherFor(handle.app, sqsPublisher(sqs, queues.eventsQueueUrl));
    expect(await publish.execute()).toEqual({ claimed: 6, published: 6, failed: 0 });
    const received = await drainEvents(sqs, queues.eventsQueueUrl, 6);
    const transactionOrder = received
      .filter((event) => event.eventType === "WagerTransactionProcessed")
      .map((event) => (event.body["data"] as Record<string, unknown>)["transactionId"]);
    expect(transactionOrder.slice(1)).toEqual([first.transactionId, second.transactionId]);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("outbox lag: age of the oldest pending event and how many are pending", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await withClock(clock);
    const queues = await eventsQueue("outbox-lag");
    const wallet = await createWallet(handle.app, "10.00");
    clock.advance(7_000);
    const publish = outboxPublisherFor(handle.app, sqsPublisher(sqs, queues.eventsQueueUrl));

    expect(await publish.measureLag()).toEqual({ pendingCount: 2, oldestPendingAgeMs: 7_000 });
    expect(handle.metrics.gauge("outbox_oldest_pending_age_ms")).toBe(7_000);
    expect(handle.metrics.gauge("outbox_pending")).toBe(2);

    await publish.execute();
    expect(await publish.measureLag()).toEqual({ pendingCount: 0, oldestPendingAgeMs: 0 });
    await drainEvents(sqs, queues.eventsQueueUrl, 2, { settleMs: 0 });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("the running loop publishes what is committed while it runs and stops cleanly", async () => {
    const { app, sql } = suite();
    const queues = await eventsQueue("outbox-loop");
    const running = await startOutboxPublisher({
      sqs,
      eventsQueueName: queues.eventsQueueName,
      config: TEST_OUTBOX_PUBLISHER,
      database: testDatabaseConfig(suite().db.name),
      application: app,
    });
    try {
      const wallet = await createWallet(app, "100.00");
      for (let i = 0; i < 3; i += 1) {
        await app.processWagerTransaction.execute(wagerCommand(wallet, "BET"), CTX);
      }
      await waitFor(async () => (await pendingOutboxCount(sql)) === 0, {
        description: "outbox drained by the loop",
      });
      const received = await drainEvents(sqs, queues.eventsQueueUrl, 8);
      expect(received.map((event) => event.eventId)).toEqual(
        (await outboxRows(sql, wallet.id)).map((row) => row.id),
      );
      await assertLedgerInvariant(sql, wallet.id);
    } finally {
      await running.stop();
    }
  });

  test("the boot refuses an SQS timeout that does not fit in idle_in_transaction_session_timeout", async () => {
    const error = await startOutboxPublisher({
      sqs,
      eventsQueueName: "irrelevant.fifo",
      config: { ...TEST_OUTBOX_PUBLISHER, sqsRequestTimeoutMs: 30_000 },
      database: testDatabaseConfig(suite().db.name, { idleInTransactionTimeoutMs: 30_000 }),
      application: suite().app,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("OUTBOX_SQS_REQUEST_TIMEOUT_MS");
  });
});

/** Test-only: leaves no pending event from an earlier test of the same database. */
async function discardPending(sql: SQL): Promise<void> {
  await sql.unsafe(
    `update outbox_messages set published_at = now(), next_attempt_at = null
      where published_at is null`,
  );
}
