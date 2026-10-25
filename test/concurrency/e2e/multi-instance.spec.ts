import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import type { WagerTransactionCommand } from "../../../src/application/wager/process-wager-transaction.ts";
import type { WalletView } from "../../../src/application/views.ts";
import { wagerCommand } from "../../support/command-builders.ts";
import { isQueueEmpty, sendCommand } from "../../support/consumer-support.ts";
import { createIsolatedDatabase, openSql } from "../../support/database.ts";
import type { IsolatedDatabase } from "../../support/database.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { waitFor } from "../../support/polling.ts";
import { ProviderClient, runLimited } from "../../support/provider-client.ts";
import type { SubmitOutcome } from "../../support/provider-client.ts";
import { createIsolatedQueues, testSqsClient } from "../../support/queues.ts";
import type { IsolatedQueues } from "../../support/queues.ts";
import {
  FULL_LAYOUT,
  TOPOLOGY_VISIBILITY_TIMEOUT_SECONDS,
  Topology,
} from "../../support/topology.ts";
import {
  drainEvents,
  outboxOrderByAggregate,
  outboxRows,
  pendingOutboxCount,
  receivedOrderByAggregate,
} from "../../support/worker-support.ts";

const INITIAL = "1000.00";
/**
 * Per wallet: 10 HTTP BETs of 10.00, 10 SQS BETs of 5.00, 5 HTTP WINs of 7.00, 3 REFUNDs sent by
 * HTTP racing their 10.00 BETs sent by SQS (either order), and one BET of 10.00 sent at once to the
 * three APIs and twice to the queue (same key). All of them fit in the balance, so the final balance
 * is exact whatever the interleaving:
 *   1000 − 100 − 50 + 35 − 30 + 30 − 10 = 875.00
 */
const EXPECTED = "875.00";
const TRANSACTIONS_PER_WALLET = 10 + 10 + 5 + 3 + 3 + 1;

interface WalletPlan {
  readonly http: (() => Promise<SubmitOutcome>)[];
  readonly sqs: (() => Promise<unknown>)[];
  readonly storm: () => Promise<readonly string[]>;
}

/**
 * The service as 3 APIs, 2 SQS consumers, an outbox publisher and the PENDING_REFERENCE worker,
 * all separate processes on one PostgreSQL and one set of queues. Traffic comes in through HTTP
 * (round robin over the APIs) and SQS at once, on the same hot wallets.
 */
describe("multi-instance service, end to end (separate processes, PostgreSQL, LocalStack)", () => {
  let db: IsolatedDatabase;
  let sql: SQL;
  let sqs: SQSClient;
  let queues: IsolatedQueues;
  let topology: Topology;
  let client: ProviderClient;

  beforeAll(async () => {
    db = await createIsolatedDatabase("e2e-multi-instance", { poolMax: 4 });
    sql = openSql(db.name, 4);
    sqs = testSqsClient();
    queues = await createIsolatedQueues("e2e-multi", {
      visibilityTimeoutSeconds: TOPOLOGY_VISIBILITY_TIMEOUT_SECONDS,
    });
    topology = new Topology(db.config, queues, FULL_LAYOUT);
    client = new ProviderClient(() => topology.apiUrls);
    await topology.startAll();
  }, 120_000);

  afterAll(async () => {
    topology.killAll();
    await queues.delete();
    sqs.destroy();
    await sql.close();
    await db.drop();
  });

  function planFor(wallet: WalletView): WalletPlan {
    const http: (() => Promise<SubmitOutcome>)[] = [];
    const sqsSends: (() => Promise<unknown>)[] = [];
    const send = (command: WagerTransactionCommand, messageId?: string) => () =>
      sendCommand(sqs, queues.wagerQueueUrl, command, messageId);
    for (let i = 0; i < 10; i += 1) {
      const bet = wagerCommand(wallet, "BET", { amount: "10.00" });
      http.push(() => client.submit(bet));
      sqsSends.push(send(wagerCommand(wallet, "BET", { amount: "5.00" })));
    }
    for (let i = 0; i < 5; i += 1) {
      const win = wagerCommand(wallet, "WIN", { amount: "7.00" });
      http.push(() => client.submit(win));
    }
    for (let i = 0; i < 3; i += 1) {
      const betId = `bet-ref-${Bun.randomUUIDv7()}`;
      const refund = wagerCommand(wallet, "REFUND", { amount: "10.00", reference: betId });
      http.push(() => client.submit(refund));
      sqsSends.push(
        send(wagerCommand(wallet, "BET", { externalTransactionId: betId, amount: "10.00" })),
      );
    }
    const contested = wagerCommand(wallet, "BET", { amount: "10.00" });
    const storm = async (): Promise<readonly string[]> => {
      const [answers] = await Promise.all([
        Promise.all(topology.apiUrls.map((_, index) => client.submit(contested, index))),
        send(contested)(),
        send(contested)(),
      ]);
      return answers.map((answer) => answer.result.transactionId);
    };
    return { http, sqs: sqsSends, storm };
  }

  /** Fires every planned request of the wallets, HTTP and SQS interleaved, `limit` at a time. */
  async function runPlans(plans: readonly WalletPlan[], limit: number) {
    const tasks: (() => Promise<unknown>)[] = [];
    const http: SubmitOutcome[] = [];
    const longest = Math.max(...plans.map((p) => p.http.length + p.sqs.length));
    for (let i = 0; i < longest; i += 1) {
      for (const plan of plans) {
        const httpTask = plan.http[i];
        const sqsTask = plan.sqs[i];
        if (httpTask !== undefined) {
          tasks.push(async () => {
            const outcome = await httpTask();
            http.push(outcome);
            return outcome;
          });
        }
        if (sqsTask !== undefined) tasks.push(sqsTask);
      }
    }
    const [, storms] = await Promise.all([
      runLimited(tasks, limit),
      Promise.all(plans.map((plan) => plan.storm())),
    ]);
    return { storms, http };
  }

  async function decidedCount(walletIds: readonly string[]): Promise<number> {
    const rows: { n: number }[] = await sql.unsafe(
      `select count(*)::int as n from wager_transactions
        where wallet_id = any(string_to_array($1, ',')::uuid[]) and kind <> 'OPENING'
          and status not in ('PENDING', 'PENDING_REFERENCE')`,
      [walletIds.join(",")],
    );
    return rows[0]?.n ?? 0;
  }

  /** Queue drained, every transaction decided, outbox fully published. */
  async function waitForQuiescence(walletIds: readonly string[]): Promise<void> {
    await waitFor(
      async () =>
        (await decidedCount(walletIds)) === walletIds.length * TRANSACTIONS_PER_WALLET &&
        (await isQueueEmpty(sqs, queues.wagerQueueUrl)) &&
        (await pendingOutboxCount(sql)) === 0,
      { timeoutMs: 90_000, intervalMs: 200, description: "the system to settle" },
    );
  }

  /** The financial proof, on EVERY wallet of the database. */
  async function assertConsistentEverywhere(expected: ReadonlyMap<string, string>): Promise<void> {
    const wallets: { id: string }[] = await sql.unsafe(`select id from wallets order by id`);
    expect(wallets.length).toBeGreaterThan(0);
    for (const { id } of wallets) {
      await assertLedgerInvariant(sql, id);
      const report = await client.reconcile(id);
      expect(report).toMatchObject({ consistent: true, difference: { amount: "0.00" } });
      const want = expected.get(id);
      if (want !== undefined) expect((await client.wallet(id)).balance.amount).toBe(want);
    }
    // Nothing applied twice, nothing left half-way.
    const duplicatedEntries: unknown[] = await sql.unsafe(
      `select transaction_id from wallet_ledger_entries group by transaction_id having count(*) > 1`,
    );
    expect(duplicatedEntries).toEqual([]);
    const undecided: unknown[] = await sql.unsafe(
      `select id from wager_transactions where status in ('PENDING', 'PENDING_REFERENCE')`,
    );
    expect(undecided).toEqual([]);
    const unprocessedInbox: unknown[] = await sql.unsafe(
      `select message_id from inbox_messages where processed_at is null`,
    );
    expect(unprocessedInbox).toEqual([]);
  }

  /** Outbox sequence already drained from the events queue by an earlier test. */
  let drainedUpTo = 0n;

  /** Every outbox event (since the last drain) reached the events queue once, in commit order. */
  async function assertEventsDelivered(): Promise<void> {
    const rows = (await outboxRows(sql)).filter((row) => BigInt(row.sequence) > drainedUpTo);
    const events = await drainEvents(sqs, queues.eventsQueueUrl, rows.length, {
      timeoutMs: 60_000,
    });
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    expect(new Set(events.map((e) => e.eventId))).toEqual(new Set(rows.map((r) => r.id)));
    expect(receivedOrderByAggregate(events)).toEqual(outboxOrderByAggregate(rows));
    drainedUpTo = rows.reduce(
      (max, row) => (BigInt(row.sequence) > max ? BigInt(row.sequence) : max),
      drainedUpTo,
    );
  }

  test("3 APIs + 2 consumers + workers on the same hot wallets, HTTP and SQS at once: every request applied exactly once", async () => {
    const wallets = await Promise.all([1, 2, 3, 4].map(() => client.createWallet(INITIAL)));
    const { storms } = await runPlans(wallets.map(planFor), 24);

    // The contested BET: the three APIs answered with the same transaction.
    for (const ids of storms) expect(new Set(ids).size).toBe(1);

    await waitForQuiescence(wallets.map((w) => w.id));
    const perWallet: { wallet_id: string; n: number }[] = await sql.unsafe(
      `select wallet_id, count(*)::int as n from wager_transactions
          where kind <> 'OPENING' group by wallet_id`,
    );
    for (const row of perWallet) expect(row.n).toBe(TRANSACTIONS_PER_WALLET);

    await assertConsistentEverywhere(new Map(wallets.map((w) => [w.id, EXPECTED])));
    await assertEventsDelivered();
  }, 180_000);

  test("restart: an API and a consumer SIGKILLed mid-traffic, then everything SIGTERMed and started again; the final state is consistent on every wallet", async () => {
    const wallets = await Promise.all([1, 2, 3, 4].map(() => client.createWallet(INITIAL)));
    const ids = wallets.map((w) => w.id);
    const total = ids.length * TRANSACTIONS_PER_WALLET;
    // Low concurrency: the traffic lasts long enough to be cut twice.
    const load = runPlans(wallets.map(planFor), 6);
    let loadFinished = false;
    void load.finally(() => {
      loadFinished = true;
    });

    await waitFor(async () => (await decidedCount(ids)) >= total * 0.25, {
      timeoutMs: 60_000,
      description: "a quarter of the traffic",
    });
    // The cuts must land on traffic in progress, not on an idle system.
    expect(loadFinished).toBe(false);
    topology.kill("api-1");
    topology.kill("sqs-consumer-1");

    await waitFor(async () => (await decidedCount(ids)) >= total * 0.5, {
      timeoutMs: 60_000,
      description: "half of the traffic",
    });
    expect(loadFinished).toBe(false);
    const exits = await topology.stopAll();
    for (const [name, code] of Object.entries(exits)) {
      expect(code, `${name}:\n${topology.output(name)}`).toBe(0);
    }

    // Everything comes back; the clients have been resending to whatever answers.
    await topology.startAll();
    const { storms, http } = await load;
    for (const ids of storms) expect(new Set(ids).size).toBe(1);
    // Some requests found their instance dead or restarting and were resent with the same key.
    expect(http.filter((outcome) => outcome.attempts > 1).length).toBeGreaterThan(0);

    await waitForQuiescence(ids);
    await assertConsistentEverywhere(new Map(ids.map((id) => [id, EXPECTED])));
    await assertEventsDelivered();
  }, 240_000);
});
