import { describe, expect, test } from "bun:test";
import { IdempotencyConflictError } from "../../../src/application/errors.ts";
import type { WagerTransactionResult } from "../../../src/application/views.ts";
import { ErrorCode } from "../../../src/domain/shared/failure-code.ts";
import { WagerTransactionStatus } from "../../../src/domain/wager/wager-transaction-status.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import {
  CTX,
  createWallet,
  ledgerRows,
  outboxEventTypes,
  settleAll,
  transactionRows,
  wagerCommand,
  walletState,
} from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { MikroOrmUnitOfWork } from "../../../src/infrastructure/persistence/mikro-orm-unit-of-work.ts";
import { holdWalletLock, raceOnWalletLock } from "../../support/lock-barrier.ts";
import { TamperingUnitOfWork, override } from "../../support/tampering.ts";

/**
 * Real parallelism inside one process: every contender runs its own SQL transaction on its own
 * pooled connection, and the lock barrier makes sure all of them are blocked on the wallet row
 * lock in PostgreSQL before the race starts. (Separate processes come with the multi-instance
 * tests; the lock lives in the database either way.)
 */
describe("wallet races (real PostgreSQL, parallel connections)", () => {
  const suite = useApplicationSuite("concurrency-wallet-races", { poolMax: 60 });
  const ITERATIONS = 20;
  const OPENING_EVENTS = 2;

  test(`100.00 and two parallel 80.00 BETs: one PROCESSED, one INSUFFICIENT_FUNDS, balance 20.00 (×${ITERATIONS})`, async () => {
    const { app, sql } = suite();
    for (let i = 0; i < ITERATIONS; i += 1) {
      const wallet = await createWallet(app, "100.00");
      const results = await raceOnWalletLock(sql, wallet.id, 2, () =>
        Promise.all([
          app.processWagerTransaction.execute(
            wagerCommand(wallet, "BET", { amount: "80.00" }),
            CTX,
          ),
          app.processWagerTransaction.execute(
            wagerCommand(wallet, "BET", { amount: "80.00" }),
            CTX,
          ),
        ]),
      );

      const statuses = results.map((r) => `${r.status}:${r.failureCode ?? "-"}`).sort();
      expect(statuses).toEqual(["PROCESSED:-", "REJECTED:INSUFFICIENT_FUNDS"]);
      const processed = results.find((r) => r.status === WagerTransactionStatus.Processed);
      const rejected = results.find((r) => r.status === WagerTransactionStatus.Rejected);
      expect(processed?.balance?.amount).toBe("20.00");
      expect(rejected?.balance?.amount).toBe("20.00");
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "20.00", version: 2 });
      const debits = (await ledgerRows(sql, wallet.id)).filter((e) => e.direction === "DEBIT");
      expect(debits.map((e) => [e.transaction_id, e.amount])).toEqual([
        [processed?.transactionId ?? "missing", "80.00"],
      ]);
      expect((await outboxEventTypes(sql, wallet.id)).slice(OPENING_EVENTS).sort()).toEqual([
        "WagerTransactionProcessed",
        "WagerTransactionRejected",
        "WalletBalanceChanged",
      ]);
      await assertLedgerInvariant(sql, wallet.id);
    }
  });

  test("the same BET sent 50 times in parallel: one debit, 49 replays of the same answer", async () => {
    const { app, sql } = suite();
    const wallet = await createWallet(app, "100.00");
    const command = wagerCommand(wallet, "BET", { amount: "25.00" });
    const results = await raceOnWalletLock(sql, wallet.id, 50, () =>
      Promise.all(
        Array.from({ length: 50 }, () => app.processWagerTransaction.execute(command, CTX)),
      ),
    );

    const original = results.filter((r) => !r.idempotentReplay);
    expect(original).toHaveLength(1);
    const expected: WagerTransactionResult = {
      transactionId: original[0]?.transactionId ?? "",
      status: WagerTransactionStatus.Processed,
      balance: { amount: "75.00", currency: "BRL" },
      idempotentReplay: true,
    };
    expect(results.filter((r) => r.idempotentReplay)).toEqual(
      Array.from({ length: 49 }, () => expected),
    );
    expect((await transactionRows(sql, wallet.id)).filter((t) => t.kind === "BET")).toHaveLength(1);
    expect((await ledgerRows(sql, wallet.id)).filter((e) => e.direction === "DEBIT")).toHaveLength(
      1,
    );
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "75.00", version: 2 });
    expect((await outboxEventTypes(sql, wallet.id)).slice(OPENING_EVENTS)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("the same SQS message delivered 20 times in parallel: one effect, one inbox row", async () => {
    const { app, sql } = suite();
    const wallet = await createWallet(app, "100.00");
    const command = wagerCommand(wallet, "BET", { amount: "10.00" });
    const delivery = { consumerName: "wager-consumer", messageId: `msg-${Bun.randomUUIDv7()}` };
    const results = await raceOnWalletLock(sql, wallet.id, 20, () =>
      Promise.all(
        Array.from({ length: 20 }, () =>
          app.processWagerTransaction.execute(command, CTX, delivery),
        ),
      ),
    );
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    const inbox: { n: number }[] = await sql.unsafe(
      "select count(*)::int as n from inbox_messages where message_id = $1",
      [delivery.messageId],
    );
    expect(inbox[0]?.n).toBe(1);
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "90.00", version: 2 });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test(`WIN × REFUND of the same BET in parallel: exactly one coherent outcome (×${ITERATIONS})`, async () => {
    const { app, sql } = suite();
    for (let i = 0; i < ITERATIONS; i += 1) {
      const wallet = await createWallet(app, "100.00");
      const betId = `bet-${Bun.randomUUIDv7()}`;
      await app.processWagerTransaction.execute(
        wagerCommand(wallet, "BET", { externalTransactionId: betId, amount: "10.00" }),
        CTX,
      );
      const [win, refund] = await raceOnWalletLock(sql, wallet.id, 2, () =>
        Promise.all([
          app.processWagerTransaction.execute(
            wagerCommand(wallet, "WIN", { reference: betId, amount: "50.00" }),
            CTX,
          ),
          app.processWagerTransaction.execute(
            wagerCommand(wallet, "REFUND", { reference: betId, amount: "10.00" }),
            CTX,
          ),
        ]),
      );
      const outcome = `WIN ${win.status}:${win.failureCode ?? "-"} / REFUND ${refund.status}:${refund.failureCode ?? "-"}`;
      const balance = (await walletState(sql, wallet.id)).balance;
      if (win.status === WagerTransactionStatus.Processed) {
        // WIN first: refunding a BET with an active WIN would pay a prize on a cancelled bet.
        expect(outcome).toBe("WIN PROCESSED:- / REFUND REJECTED:REFERENCE_HAS_ACTIVE_SETTLEMENT");
        expect(balance).toBe("140.00");
      } else {
        // REFUND first: the bet is cancelled, so its WIN is refused.
        expect(outcome).toBe("WIN REJECTED:REFERENCE_ALREADY_REVERSED / REFUND PROCESSED:-");
        expect(balance).toBe("100.00");
      }
      await assertLedgerInvariant(sql, wallet.id);
    }
  });

  test("two REFUNDs (different ids) of the same BET in parallel: one reversal only", async () => {
    const { app, sql } = suite();
    const wallet = await createWallet(app, "100.00");
    const betId = `bet-${Bun.randomUUIDv7()}`;
    await app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: betId, amount: "10.00" }),
      CTX,
    );
    const results = await raceOnWalletLock(sql, wallet.id, 2, () =>
      Promise.all([
        app.processWagerTransaction.execute(
          wagerCommand(wallet, "REFUND", { reference: betId }),
          CTX,
        ),
        app.processWagerTransaction.execute(
          wagerCommand(wallet, "REFUND", { reference: betId }),
          CTX,
        ),
      ]),
    );
    expect(results.map((r) => `${r.status}:${r.failureCode ?? "-"}`).sort()).toEqual([
      "PROCESSED:-",
      "REJECTED:REFERENCE_ALREADY_REVERSED",
    ]);
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "100.00", version: 3 });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("no global lock: wallet B is processed while wallet A's lock is held", async () => {
    const { app, sql } = suite();
    const a = await createWallet(app, "100.00");
    const b = await createWallet(app, "100.00");
    const lock = await holdWalletLock(sql, a.id);
    try {
      const result = await app.processWagerTransaction.execute(
        wagerCommand(b, "BET", { amount: "10.00" }),
        CTX,
      );
      expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "90.00" } });
    } finally {
      await lock.release();
    }
    await assertLedgerInvariant(sql, a.id);
    await assertLedgerInvariant(sql, b.id);
  });

  test("distinct wallets processed in parallel all succeed", async () => {
    const { app, sql } = suite();
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(app, "50.00")));
    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 3 }, () =>
          app.processWagerTransaction.execute(
            wagerCommand(wallet, "BET", { amount: "10.00" }),
            CTX,
          ),
        ),
      ),
    );
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    for (const wallet of wallets) {
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "20.00", version: 4 });
      await assertLedgerInvariant(sql, wallet.id);
    }
  });

  test("same idempotency key for two different wallets in parallel: one processed, one conflict", async () => {
    const { app, sql } = suite();
    const a = await createWallet(app, "100.00");
    const b = await createWallet(app, "100.00");
    const shared = { externalTransactionId: `tx-${Bun.randomUUIDv7()}`, amount: "10.00" };
    const { values, errors } = await raceOnWalletLock(sql, [a.id, b.id], 2, () =>
      settleAll([
        app.processWagerTransaction.execute(wagerCommand(a, "BET", shared), CTX),
        app.processWagerTransaction.execute(wagerCommand(b, "BET", shared), CTX),
      ]),
    );
    expect(values).toHaveLength(1);
    expect(values[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(IdempotencyConflictError);
    expect(errors[0]).toMatchObject({ code: ErrorCode.IdempotencyKeyReused });
    const balances = [
      (await walletState(sql, a.id)).balance,
      (await walletState(sql, b.id)).balance,
    ];
    expect(balances.sort()).toEqual(["100.00", "90.00"]);
    await assertLedgerInvariant(sql, a.id);
    await assertLedgerInvariant(sql, b.id);
  });

  test("deterministic interleaving: the key is committed for another wallet between our check and our INSERT", async () => {
    const { app, sql } = suite();
    const a = await createWallet(app, "100.00");
    const b = await createWallet(app, "100.00");
    const shared = { externalTransactionId: `tx-${Bun.randomUUIDv7()}`, amount: "10.00" };
    let competitor: Promise<WagerTransactionResult> | undefined;
    const interleaved = await suite().open({
      dependencies: (orm) => ({
        unitOfWork: new TamperingUnitOfWork(new MikroOrmUnitOfWork(orm), (scope) => ({
          ...scope,
          transactions: override(scope.transactions, {
            insert: async (tx) => {
              // First attempt only: our idempotency check already ran and saw nothing. Another
              // instance now commits the same key for wallet B (no lock in common with us).
              if (competitor === undefined) {
                competitor = app.processWagerTransaction.execute(
                  wagerCommand(b, "BET", shared),
                  CTX,
                );
                await competitor;
              }
              await scope.transactions.insert(tx);
            },
          }),
        })),
      }),
    });

    // 23505 on the idempotency key → the attempt restarts → it now sees B's row → conflict.
    const error = await interleaved.app.processWagerTransaction
      .execute(wagerCommand(a, "BET", shared), CTX)
      .catch((e: unknown) => e);
    expect(await competitor).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(error).toMatchObject({ code: ErrorCode.IdempotencyKeyReused });
    expect(await walletState(sql, a.id)).toEqual({ balance: "100.00", version: 1 });
    expect(await walletState(sql, b.id)).toEqual({ balance: "90.00", version: 2 });
    await assertLedgerInvariant(sql, a.id);
    await assertLedgerInvariant(sql, b.id);
  });
});
