import { describe, expect, test } from "bun:test";
import {
  InvalidCommandError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../../src/application/errors.ts";
import { MAX_LEDGER_PAGE_LIMIT } from "../../../src/application/queries/queries.ts";
import { InvalidMoneyError } from "../../../src/domain/shared/money.errors.ts";
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

describe("CreateWallet, ReconcileWallet and queries (real PostgreSQL)", () => {
  const suite = useApplicationSuite("app-wallets-queries", { poolMax: 12 });

  describe("CreateWallet", () => {
    test("zero balance: version 1, no OPENING, no ledger entry, no event", async () => {
      const { sql, app } = suite();
      const wallet = await createWallet(app, "0.00");
      expect(wallet).toEqual({
        id: wallet.id,
        playerId: wallet.playerId,
        balance: { amount: "0.00", currency: "BRL" },
        version: 1,
      });
      expect(await transactionRows(sql, wallet.id)).toEqual([]);
      expect(await ledgerRows(sql, wallet.id)).toEqual([]);
      expect(await outboxEventTypes(sql, wallet.id)).toEqual([]);
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("positive balance: OPENING PROCESSED + CREDIT at version 1 + Processed and BalanceChanged", async () => {
      const { sql, app } = suite();
      const wallet = await createWallet(app, "1000.00");
      expect(wallet.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(wallet.version).toBe(1);
      const [opening] = await transactionRows(sql, wallet.id);
      if (opening === undefined) throw new Error("the OPENING transaction must exist");
      expect(opening).toMatchObject({ kind: "OPENING", status: "PROCESSED" });
      expect(await ledgerRows(sql, wallet.id)).toEqual([
        {
          transaction_id: opening.id,
          direction: "CREDIT",
          amount: "1000.00",
          wallet_version: 1,
        },
      ]);
      expect(await outboxEventTypes(sql, wallet.id)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      const payloads: { payload: { data: { transactionId: string; kind?: string } } }[] =
        await sql.unsafe(
          "select payload from outbox_messages where aggregate_id = $1 order by occurred_at, id",
          [wallet.id],
        );
      // The balance change points to a transaction that was announced as processed.
      expect(payloads.map((p) => p.payload.data.transactionId)).toEqual([opening.id, opening.id]);
      expect(payloads[0]?.payload.data.kind).toBe("OPENING");
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("duplicate player + currency is a conflict; another currency is fine", async () => {
      const { app } = suite();
      const playerId = Bun.randomUUIDv7();
      await app.createWallet.execute(
        { playerId, initialBalance: { amount: "10.00", currency: "BRL" } },
        CTX,
      );
      const error = await app.createWallet
        .execute({ playerId, initialBalance: { amount: "5.00", currency: "BRL" } }, CTX)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WalletAlreadyExistsError);
      const usd = await app.createWallet.execute(
        { playerId, initialBalance: { amount: "5.00", currency: "USD" } },
        CTX,
      );
      expect(usd.balance.currency).toBe("USD");
    });

    test("10 parallel creations for the same player and currency: exactly one wins", async () => {
      const { sql, app } = suite();
      const playerId = Bun.randomUUIDv7();
      const { values, errors } = await settleAll(
        Array.from({ length: 10 }, () =>
          app.createWallet.execute(
            { playerId, initialBalance: { amount: "100.00", currency: "BRL" } },
            CTX,
          ),
        ),
      );
      expect(values).toHaveLength(1);
      expect(errors).toHaveLength(9);
      for (const error of errors) expect(error).toBeInstanceOf(WalletAlreadyExistsError);
      const rows: { id: string }[] = await sql.unsafe(
        "select id from wallets where player_id = $1",
        [playerId],
      );
      expect(rows.map((r) => r.id)).toEqual([values[0]?.id ?? "missing"]);
      const openings: { n: number }[] = await sql.unsafe(
        "select count(*)::int as n from wager_transactions where player_id = $1 and kind = 'OPENING'",
        [playerId],
      );
      expect(openings[0]?.n).toBe(1);
      await assertLedgerInvariant(sql, rows[0]?.id ?? "");
    });

    test.each([
      ["negative balance", { amount: "-1.00", currency: "BRL" }, InvalidMoneyError],
      ["3 decimals", { amount: "1.000", currency: "BRL" }, InvalidMoneyError],
      ["lowercase currency", { amount: "1.00", currency: "brl" }, InvalidMoneyError],
    ] as const)("invalid initial balance: %s", async (_label, initialBalance, errorClass) => {
      const error = await suite()
        .app.createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance }, CTX)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(errorClass);
    });

    test("invalid playerId", async () => {
      const error = await suite()
        .app.createWallet.execute(
          { playerId: "player-1", initialBalance: { amount: "1.00", currency: "BRL" } },
          CTX,
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidCommandError);
    });
  });

  describe("ReconcileWallet", () => {
    test("consistent wallet: difference 0.00 and every entry checked", async () => {
      const { app, sql } = suite();
      const wallet = await createWallet(app, "100.00");
      await app.processWagerTransaction.execute(
        wagerCommand(wallet, "BET", { amount: "30.00" }),
        CTX,
      );
      await app.processWagerTransaction.execute(
        wagerCommand(wallet, "WIN", { amount: "5.00" }),
        CTX,
      );
      await app.processWagerTransaction.execute(
        wagerCommand(wallet, "LOSS", { amount: "0.00" }),
        CTX,
      );

      const report = await app.reconcileWallet.execute(wallet.id, CTX);
      expect(report).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: "75.00", currency: "BRL" },
        calculatedBalance: { amount: "75.00", currency: "BRL" },
        difference: { amount: "0.00", currency: "BRL" },
        consistent: true,
        checkedEntries: 3,
      });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("wallet without entries is consistent at 0.00", async () => {
      const wallet = await createWallet(suite().app, "0.00");
      const report = await suite().app.reconcileWallet.execute(wallet.id, CTX);
      expect(report).toMatchObject({ consistent: true, checkedEntries: 0 });
    });

    test("divergence is reported, counted and NOT corrected", async () => {
      const { app, sql, metrics } = suite();
      const wallet = await createWallet(app, "100.00");
      // Corrupt the stored balance on purpose, bypassing every trigger (test superuser only):
      // the schema would otherwise refuse it at COMMIT (wallets_matches_ledger).
      await sql.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        await tx.unsafe("update wallets set balance = balance + 5.00 where id = $1", [wallet.id]);
      });
      const divergencesBefore = metrics.count("reconciliation_divergence");

      const report = await app.reconcileWallet.execute(wallet.id, CTX);
      expect(report).toMatchObject({
        storedBalance: { amount: "105.00" },
        calculatedBalance: { amount: "100.00" },
        difference: { amount: "5.00", currency: "BRL" },
        consistent: false,
        checkedEntries: 1,
      });
      expect(metrics.count("reconciliation_divergence")).toBe(divergencesBefore + 1);
      expect((await walletState(sql, wallet.id)).balance).toBe("105.00");
      // The invariant is exactly what this wallet violates.
      const invariant = await assertLedgerInvariant(sql, wallet.id).then(
        () => "holds",
        () => "violated",
      );
      expect(invariant).toBe("violated");
    });

    test("unknown wallet", async () => {
      const error = await suite()
        .app.reconcileWallet.execute(Bun.randomUUIDv7(), CTX)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WalletNotFoundError);
    });
  });

  describe("queries", () => {
    test("GetWallet", async () => {
      const { app } = suite();
      const wallet = await createWallet(app, "42.00");
      expect(await app.getWallet.execute(wallet.id)).toEqual(wallet);
      const error = await app.getWallet.execute(Bun.randomUUIDv7()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WalletNotFoundError);
    });

    test("GetLedgerPage walks the ledger by wallet_version with a stable cursor", async () => {
      const { app, sql } = suite();
      const wallet = await createWallet(app, "100.00");
      for (let i = 0; i < 4; i += 1) {
        await app.processWagerTransaction.execute(
          wagerCommand(wallet, "BET", { amount: "1.00" }),
          CTX,
        );
      }
      const first = await app.getLedgerPage.execute({ walletId: wallet.id, limit: 2 });
      expect(first.entries.map((e) => e.walletVersion)).toEqual([1, 2]);
      expect(first.nextAfterVersion).toBe(2);
      const second = await app.getLedgerPage.execute({
        walletId: wallet.id,
        afterVersion: first.nextAfterVersion,
        limit: 2,
      });
      expect(second.entries.map((e) => e.walletVersion)).toEqual([3, 4]);
      const last = await app.getLedgerPage.execute({
        walletId: wallet.id,
        afterVersion: second.nextAfterVersion,
        limit: 2,
      });
      expect(last.entries.map((e) => e.walletVersion)).toEqual([5]);
      expect(last.nextAfterVersion).toBeUndefined();
      expect(last.entries[0]).toMatchObject({
        direction: "DEBIT",
        money: { amount: "1.00", currency: "BRL" },
        balanceBefore: { amount: "97.00", currency: "BRL" },
        balanceAfter: { amount: "96.00", currency: "BRL" },
      });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("GetLedgerPage validates limit, cursor and wallet", async () => {
      const { app } = suite();
      const wallet = await createWallet(app, "1.00");
      for (const limit of [0, MAX_LEDGER_PAGE_LIMIT + 1, 1.5]) {
        const error = await app.getLedgerPage
          .execute({ walletId: wallet.id, limit })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(InvalidCommandError);
      }
      const badCursor = await app.getLedgerPage
        .execute({ walletId: wallet.id, afterVersion: -1, limit: 10 })
        .catch((e: unknown) => e);
      expect(badCursor).toBeInstanceOf(InvalidCommandError);
      const missing = await app.getLedgerPage
        .execute({ walletId: Bun.randomUUIDv7(), limit: 10 })
        .catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(WalletNotFoundError);
    });

    test("GetTransaction and GetTransactionByExternalId (scoped by provider)", async () => {
      const { app } = suite();
      const wallet = await createWallet(app, "100.00");
      const command = wagerCommand(wallet, "BET", {
        externalTransactionId: "lookup-1",
        amount: "12.34",
      });
      const result = await app.processWagerTransaction.execute(command, CTX);

      const byId = await app.getTransaction.execute(result.transactionId);
      expect(byId).toMatchObject({
        transactionId: result.transactionId,
        providerId: "provider-a",
        externalTransactionId: "lookup-1",
        walletId: wallet.id,
        kind: "BET",
        money: { amount: "12.34", currency: "BRL" },
        status: "PROCESSED",
        balance: { amount: "87.66", currency: "BRL" },
      });
      expect(await app.getTransactionByExternalId.execute("provider-a", "lookup-1")).toEqual(byId);

      const otherProvider = await app.getTransactionByExternalId
        .execute("provider-b", "lookup-1")
        .catch((e: unknown) => e);
      expect(otherProvider).toBeInstanceOf(TransactionNotFoundError);
      const unknown = await app.getTransaction.execute(Bun.randomUUIDv7()).catch((e: unknown) => e);
      expect(unknown).toBeInstanceOf(TransactionNotFoundError);
    });
  });
});
