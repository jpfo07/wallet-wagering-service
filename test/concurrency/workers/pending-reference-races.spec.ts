import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { WagerTransactionStatus as Status } from "../../../src/domain/wager/wager-transaction-status.ts";
import { startPendingReferenceWorker } from "../../../src/infrastructure/workers/start-pending-reference-worker.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import type { AppHandle } from "../../support/application-suite.ts";
import {
  CTX,
  createWallet,
  ledgerRows,
  settleAll,
  wagerCommand,
  walletState,
} from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { raceOnWalletLock } from "../../support/lock-barrier.ts";
import { waitFor } from "../../support/polling.ts";
import { TEST_PENDING_REFERENCE_WORKER } from "../../support/test-env.ts";

async function pendingCount(sql: SQL, walletIds: readonly string[]): Promise<number> {
  const rows: { n: number }[] = await sql.unsafe(
    `select count(*)::int as n from wager_transactions
      where status = 'PENDING_REFERENCE' and wallet_id = any($1::uuid[])`,
    [`{${walletIds.join(",")}}`],
  );
  return rows[0]?.n ?? 0;
}

async function processedEventsOf(sql: SQL, transactionId: string): Promise<number> {
  const rows: { n: number }[] = await sql.unsafe(
    `select count(*)::int as n from outbox_messages
      where event_type = 'WagerTransactionProcessed'
        and payload->'data'->>'transactionId' = $1`,
    [transactionId],
  );
  return rows[0]?.n ?? 0;
}

const deadlocks = (handles: readonly AppHandle[]): number =>
  handles.reduce((sum, handle) => sum + handle.metrics.count("transient_retry{reason=40P01}"), 0);

/**
 * Real parallelism on PostgreSQL: each handle is another "instance" with its own connection pool.
 * The worker locks the wallet first and the use case does too, so they never wait on each other in
 * opposite orders.
 */
describe("PENDING_REFERENCE worker under contention (real PostgreSQL)", () => {
  const suite = useApplicationSuite("concurrency-pending-reference", { poolMax: 10 });

  test("worker cycles and incoming BETs on the same wallet in parallel: no deadlock, each REFUND applied once", async () => {
    const { app, sql } = suite();
    const handles = await Promise.all([1, 2, 3, 4].map(() => suite().open()));
    const [producerA, producerB, workerA, workerB] = handles as [
      AppHandle,
      AppHandle,
      AppHandle,
      AppHandle,
    ];
    const wallet = await createWallet(app, "1000.00");
    const refunds = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.processWagerTransaction.execute(
          wagerCommand(wallet, "REFUND", { amount: "10.00", reference: `bet-${i}` }),
          CTX,
        ),
      ),
    );
    expect(refunds.every((refund) => refund.status === Status.PendingReference)).toBe(true);

    let done = false;
    const workerLoop = async (handle: AppHandle): Promise<void> => {
      while (!done) {
        const candidates = await handle.app.recheckPendingReferences.dueCandidates(50);
        for (const candidate of candidates) {
          await handle.app.recheckPendingReferences.recheck(candidate);
        }
        await Bun.sleep(5);
      }
    };
    const workers = [workerLoop(workerA), workerLoop(workerB)];
    const bets = Array.from({ length: 20 }, (_, i) =>
      (i % 2 === 0 ? producerA : producerB).app.processWagerTransaction.execute(
        wagerCommand(wallet, "BET", { externalTransactionId: `bet-${i}`, amount: "10.00" }),
        CTX,
      ),
    );
    const unrelated = Array.from({ length: 10 }, (_, i) =>
      (i % 2 === 0 ? producerB : producerA).app.processWagerTransaction.execute(
        wagerCommand(wallet, "BET", { amount: "5.00" }),
        CTX,
      ),
    );
    const produced = await settleAll([...bets, ...unrelated]);
    try {
      await waitFor(async () => (await pendingCount(sql, [wallet.id])) === 0, {
        timeoutMs: 20_000,
        description: "every REFUND resolved",
      });
    } finally {
      done = true;
    }
    const workerResults = await settleAll(workers);

    expect(produced.errors).toEqual([]);
    expect(workerResults.errors).toEqual([]);
    expect(deadlocks(handles)).toBe(0);
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "950.00", version: 51 });
    const ledger = await ledgerRows(sql, wallet.id);
    for (const refund of refunds) {
      expect(ledger.filter((row) => row.transaction_id === refund.transactionId)).toHaveLength(1);
      expect(await processedEventsOf(sql, refund.transactionId)).toBe(1);
    }
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("two workers released on the same candidate at once: one applies it, the other skips", async () => {
    const { app, sql } = suite();
    const first = await suite().open();
    const second = await suite().open();
    const wallet = await createWallet(app, "100.00");
    const refund = await app.processWagerTransaction.execute(
      wagerCommand(wallet, "REFUND", { amount: "25.00", reference: "bet-race" }),
      CTX,
    );
    await app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-race", amount: "25.00" }),
      CTX,
    );
    const candidate = { transactionId: refund.transactionId, walletId: wallet.id };

    const outcomes = await raceOnWalletLock(sql, wallet.id, 2, () =>
      Promise.all([
        first.app.recheckPendingReferences.recheck(candidate),
        second.app.recheckPendingReferences.recheck(candidate),
      ]),
    );
    expect([...outcomes].sort()).toEqual([Status.Processed, "SKIPPED"]);
    expect(
      (await ledgerRows(sql, wallet.id)).filter(
        (row) => row.transaction_id === refund.transactionId,
      ),
    ).toHaveLength(1);
    expect(await processedEventsOf(sql, refund.transactionId)).toBe(1);
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "100.00", version: 3 });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("two running worker loops over many wallets resolve every pending exactly once", async () => {
    const { app, sql } = suite();
    const handles = await Promise.all([suite().open(), suite().open()]);
    const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet(app, "100.00")));
    const pending = await Promise.all(
      wallets.flatMap((wallet) =>
        [0, 1, 2].map((i) =>
          app.processWagerTransaction.execute(
            wagerCommand(wallet, i === 2 ? "WIN" : "REFUND", {
              amount: "10.00",
              reference: `bet-${wallet.id}-${i}`,
            }),
            CTX,
          ),
        ),
      ),
    );
    const loops = handles.map((handle) =>
      startPendingReferenceWorker({
        application: handle.app,
        config: TEST_PENDING_REFERENCE_WORKER,
      }),
    );
    try {
      await Promise.all(
        wallets.flatMap((wallet) =>
          [0, 1, 2].map((i) =>
            app.processWagerTransaction.execute(
              wagerCommand(wallet, "BET", {
                externalTransactionId: `bet-${wallet.id}-${i}`,
                amount: "10.00",
              }),
              CTX,
            ),
          ),
        ),
      );
      await waitFor(
        async () =>
          (await pendingCount(
            sql,
            wallets.map((wallet) => wallet.id),
          )) === 0,
        { timeoutMs: 20_000, description: "all pending resolved by the loops" },
      );
    } finally {
      await Promise.all(loops.map((loop) => loop.stop()));
    }

    for (const transaction of pending) {
      expect(await processedEventsOf(sql, transaction.transactionId)).toBe(1);
    }
    expect(deadlocks(handles)).toBe(0);
    for (const wallet of wallets) {
      // −30 (3 BETs) +20 (2 REFUNDs) +10 (WIN)
      expect((await walletState(sql, wallet.id)).balance).toBe("100.00");
      expect(await ledgerRows(sql, wallet.id)).toHaveLength(7);
      await assertLedgerInvariant(sql, wallet.id);
    }
  });
});
