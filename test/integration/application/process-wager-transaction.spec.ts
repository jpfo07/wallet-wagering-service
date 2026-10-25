import { describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  WalletNotFoundError,
} from "../../../src/application/errors.ts";
import type { WalletView } from "../../../src/application/views.ts";
import { ErrorCode, FailureCode } from "../../../src/domain/shared/failure-code.ts";
import { InvalidMoneyError } from "../../../src/domain/shared/money.errors.ts";
import { WagerTransactionStatus } from "../../../src/domain/wager/wager-transaction-status.ts";
import { InvalidWagerTransactionError } from "../../../src/domain/wager/wager-transaction.errors.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import {
  CTX,
  createWallet,
  ledgerRows,
  outboxEventTypes,
  transactionRows,
  wagerCommand,
  walletState,
} from "../../support/command-builders.ts";
import type { WagerKind, WagerOverrides } from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";

const OPENING_EVENTS = ["WagerTransactionProcessed", "WalletBalanceChanged"];

describe("ProcessWagerTransaction (real PostgreSQL)", () => {
  const suite = useApplicationSuite("app-process-wager");

  const submit = (wallet: WalletView, kind: WagerKind, overrides: WagerOverrides = {}) =>
    suite().app.processWagerTransaction.execute(wagerCommand(wallet, kind, overrides), CTX);

  /** Events written after the wallet was created. */
  const newEvents = async (walletId: string) =>
    (await outboxEventTypes(suite().sql, walletId)).slice(OPENING_EVENTS.length);

  describe("applied transactions", () => {
    test("BET debits: ledger DEBIT, version+1, observed balance, Processed + BalanceChanged", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const result = await submit(wallet, "BET", { amount: "25.00" });

      expect(result).toEqual({
        transactionId: result.transactionId,
        status: WagerTransactionStatus.Processed,
        balance: { amount: "75.00", currency: "BRL" },
        idempotentReplay: false,
      });
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "75.00", version: 2 });
      const ledger = await ledgerRows(sql, wallet.id);
      expect(ledger.at(-1)).toMatchObject({
        transaction_id: result.transactionId,
        direction: "DEBIT",
        amount: "25.00",
        wallet_version: 2,
      });
      expect(await newEvents(wallet.id)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("WIN with and without a reference credits", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-w1", amount: "10.00" });
      const referenced = await submit(wallet, "WIN", { reference: "bet-w1", amount: "30.00" });
      const free = await submit(wallet, "WIN", { amount: "5.00" });

      expect(referenced.status).toBe(WagerTransactionStatus.Processed);
      expect(referenced.balance?.amount).toBe("120.00");
      expect(free.balance?.amount).toBe("125.00");
      expect((await ledgerRows(sql, wallet.id)).map((e) => e.direction)).toEqual([
        "CREDIT",
        "DEBIT",
        "CREDIT",
        "CREDIT",
      ]);
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("LOSS is PROCESSED without ledger entry, version change or BalanceChanged", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-l1", amount: "10.00" });
      const before = await walletState(sql, wallet.id);
      const loss = await submit(wallet, "LOSS", { reference: "bet-l1", amount: "0.00" });

      expect(loss).toMatchObject({ status: "PROCESSED", balance: { amount: "90.00" } });
      expect(await walletState(sql, wallet.id)).toEqual(before);
      expect(await ledgerRows(sql, wallet.id)).toHaveLength(2);
      expect(await newEvents(wallet.id)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
        "WagerTransactionProcessed",
      ]);
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("REFUND of a BET credits it back", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-r1", amount: "40.00" });
      const refund = await submit(wallet, "REFUND", { reference: "bet-r1", amount: "40.00" });

      expect(refund).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
      expect((await ledgerRows(sql, wallet.id)).at(-1)?.direction).toBe("CREDIT");
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("ROLLBACK inverts its reference: BET → credit, WIN → debit, REFUND → debit", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-a", amount: "10.00" });
      const ofBet = await submit(wallet, "ROLLBACK", { reference: "bet-a", amount: "10.00" });
      await submit(wallet, "BET", { externalTransactionId: "bet-b", amount: "10.00" });
      await submit(wallet, "WIN", {
        externalTransactionId: "win-b",
        reference: "bet-b",
        amount: "50.00",
      });
      const ofWin = await submit(wallet, "ROLLBACK", { reference: "win-b", amount: "50.00" });
      await submit(wallet, "BET", { externalTransactionId: "bet-c", amount: "20.00" });
      await submit(wallet, "REFUND", {
        externalTransactionId: "refund-c",
        reference: "bet-c",
        amount: "20.00",
      });
      const ofRefund = await submit(wallet, "ROLLBACK", { reference: "refund-c", amount: "20.00" });

      expect(ofBet.balance?.amount).toBe("100.00");
      expect(ofWin.balance?.amount).toBe("90.00");
      expect(ofRefund.balance?.amount).toBe("70.00");
      const directions = (await ledgerRows(sql, wallet.id)).map((e) => e.direction);
      expect(directions).toEqual([
        "CREDIT", // opening
        "DEBIT", // bet-a
        "CREDIT", // rollback of bet-a
        "DEBIT", // bet-b
        "CREDIT", // win-b
        "DEBIT", // rollback of win-b
        "DEBIT", // bet-c
        "CREDIT", // refund-c
        "DEBIT", // rollback of refund-c
      ]);
      await assertLedgerInvariant(sql, wallet.id);
    });
  });

  describe("business rejections are persisted, with an event and without a ledger entry", () => {
    const expectRejected = async (
      wallet: WalletView,
      run: () => Promise<{ status: string; failureCode?: string; balance?: { amount: string } }>,
      code: FailureCode,
    ) => {
      const { sql } = suite();
      const ledgerBefore = (await ledgerRows(sql, wallet.id)).length;
      const stateBefore = await walletState(sql, wallet.id);
      const result = await run();
      expect(result).toMatchObject({ status: "REJECTED", failureCode: code });
      expect(result.balance?.amount).toBe(stateBefore.balance);
      expect(await ledgerRows(sql, wallet.id)).toHaveLength(ledgerBefore);
      expect(await walletState(sql, wallet.id)).toEqual(stateBefore);
      expect((await outboxEventTypes(sql, wallet.id)).at(-1)).toBe("WagerTransactionRejected");
      await assertLedgerInvariant(sql, wallet.id);
    };

    test("INSUFFICIENT_FUNDS", async () => {
      const wallet = await createWallet(suite().app, "10.00");
      await expectRejected(
        wallet,
        () => submit(wallet, "BET", { amount: "10.01" }),
        FailureCode.InsufficientFunds,
      );
    });

    test("REVERSAL_WOULD_OVERDRAW (distinct from INSUFFICIENT_FUNDS)", async () => {
      // 100 → BET 10 (90) → WIN 30 (120) → BET 100 (20): undoing the WIN would need 30.
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-o", amount: "10.00" });
      await submit(wallet, "WIN", {
        externalTransactionId: "win-o",
        reference: "bet-o",
        amount: "30.00",
      });
      await submit(wallet, "BET", { amount: "100.00" });
      await expectRejected(
        wallet,
        () => submit(wallet, "ROLLBACK", { reference: "win-o", amount: "30.00" }),
        FailureCode.ReversalWouldOverdraw,
      );
    });

    test("CURRENCY_MISMATCH", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      await expectRejected(
        wallet,
        () => submit(wallet, "BET", { currency: "USD" }),
        FailureCode.CurrencyMismatch,
      );
    });

    test("WALLET_PLAYER_MISMATCH", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      await expectRejected(
        wallet,
        () => submit(wallet, "BET", { playerId: Bun.randomUUIDv7() }),
        FailureCode.WalletPlayerMismatch,
      );
    });

    test("REFERENCE_MISMATCH (other round)", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-m", roundId: "round-1" });
      await expectRejected(
        wallet,
        () => submit(wallet, "REFUND", { reference: "bet-m", roundId: "round-2" }),
        FailureCode.ReferenceMismatch,
      );
    });

    test("REFERENCE_MISMATCH (reference belongs to another wallet)", async () => {
      const other = await createWallet(suite().app, "100.00");
      const wallet = await createWallet(suite().app, "100.00");
      await submit(other, "BET", { externalTransactionId: "bet-other-wallet" });
      await expectRejected(
        wallet,
        () => submit(wallet, "REFUND", { reference: "bet-other-wallet" }),
        FailureCode.ReferenceMismatch,
      );
    });

    test("REFERENCE_KIND_NOT_ALLOWED (REFUND of a WIN)", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "WIN", { externalTransactionId: "win-k" });
      await expectRejected(
        wallet,
        () => submit(wallet, "REFUND", { reference: "win-k" }),
        FailureCode.ReferenceKindNotAllowed,
      );
    });

    test("REFERENCE_ALREADY_REVERSED (second reversal of the same BET)", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-twice" });
      await submit(wallet, "REFUND", { reference: "bet-twice" });
      await expectRejected(
        wallet,
        () => submit(wallet, "ROLLBACK", { reference: "bet-twice" }),
        FailureCode.ReferenceAlreadyReversed,
      );
    });

    test("REFERENCE_HAS_ACTIVE_SETTLEMENT (REFUND of a BET with an active WIN)", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-s" });
      await submit(wallet, "WIN", { reference: "bet-s", amount: "50.00" });
      await expectRejected(
        wallet,
        () => submit(wallet, "REFUND", { reference: "bet-s" }),
        FailureCode.ReferenceHasActiveSettlement,
      );
    });

    test("AMOUNT_MISMATCH (partial refund)", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-p", amount: "10.00" });
      await expectRejected(
        wallet,
        () => submit(wallet, "REFUND", { reference: "bet-p", amount: "5.00" }),
        FailureCode.AmountMismatch,
      );
    });

    test("REFERENCE_NOT_PROCESSED (reference was REJECTED)", async () => {
      const wallet = await createWallet(suite().app, "5.00");
      await submit(wallet, "BET", { externalTransactionId: "bet-rejected", amount: "10.00" });
      await expectRejected(
        wallet,
        () => submit(wallet, "REFUND", { reference: "bet-rejected", amount: "10.00" }),
        FailureCode.ReferenceNotProcessed,
      );
    });
  });

  test("PENDING_REFERENCE: REFUND before its BET waits, scheduled, with its event", async () => {
    const { sql } = suite();
    const wallet = await createWallet(suite().app, "100.00");
    const result = await submit(wallet, "REFUND", { reference: "bet-not-yet" });

    expect(result).toMatchObject({
      status: "PENDING_REFERENCE",
      balance: { amount: "100.00" },
      idempotentReplay: false,
    });
    const rows: {
      next_reference_check_at: Date | null;
      reference_expires_at: Date | null;
      reference_attempts: number;
    }[] = await sql.unsafe(
      `select next_reference_check_at, reference_expires_at, reference_attempts
         from wager_transactions where id = $1`,
      [result.transactionId],
    );
    expect(rows[0]?.next_reference_check_at).toBeInstanceOf(Date);
    expect(rows[0]?.reference_expires_at).toBeInstanceOf(Date);
    expect(rows[0]?.reference_attempts).toBe(0);
    expect(await ledgerRows(sql, wallet.id)).toHaveLength(1);
    expect(await newEvents(wallet.id)).toEqual(["WagerTransactionPendingReference"]);
    await assertLedgerInvariant(sql, wallet.id);
  });

  describe("nothing is persisted when there is no transaction to record", () => {
    test("WALLET_NOT_FOUND", async () => {
      const { sql } = suite();
      const ghost = Bun.randomUUIDv7();
      const wallet = await createWallet(suite().app, "100.00");
      const error = await submit(wallet, "BET", { walletId: ghost }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect(await transactionRows(sql, ghost)).toEqual([]);
      expect(await outboxEventTypes(sql, ghost)).toEqual([]);
    });

    test.each([
      ["OPENING submitted by a provider", { kind: "OPENING" }, InvalidWagerTransactionError],
      ["unknown kind", { kind: "JACKPOT" }, InvalidWagerTransactionError],
      [
        "amount with 3 decimals",
        { money: { amount: "1.000", currency: "BRL" } },
        InvalidMoneyError,
      ],
      ["negative amount", { money: { amount: "-1.00", currency: "BRL" } }, InvalidMoneyError],
      ["malformed uuid", { walletId: "0192f291-27dd-7d3f-8071" }, InvalidCommandError],
      ["blank roundId", { roundId: "  " }, InvalidCommandError],
      ["256-char providerId", { providerId: "p".repeat(256) }, InvalidCommandError],
    ] as const)("invalid payload: %s", async (_label, patch, errorClass) => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const command = { ...wagerCommand(wallet, "BET"), ...patch };
      const error = await suite()
        .app.processWagerTransaction.execute(command, CTX)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(errorClass);
      expect(await transactionRows(sql, wallet.id)).toHaveLength(1); // only the OPENING
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("BET with a reference is REFERENCE_NOT_ALLOWED", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      const error = await submit(wallet, "BET", { reference: "x" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidWagerTransactionError);
      expect((error as InvalidWagerTransactionError).code).toBe(ErrorCode.ReferenceNotAllowed);
    });
  });

  describe("idempotency", () => {
    test("replay returns the balance observed back then, not the current one", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const command = wagerCommand(wallet, "BET", { amount: "25.00" });
      const first = await suite().app.processWagerTransaction.execute(command, CTX);
      await submit(wallet, "WIN", { amount: "10.00" });
      const eventsBefore = await outboxEventTypes(sql, wallet.id);
      const rowsBefore = await transactionRows(sql, wallet.id);

      const replay = await suite().app.processWagerTransaction.execute(command, CTX);
      expect(first.balance?.amount).toBe("75.00");
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "85.00", version: 3 });
      expect(await transactionRows(sql, wallet.id)).toEqual(rowsBefore);
      expect(await outboxEventTypes(sql, wallet.id)).toEqual(eventsBefore);
      expect(suite().metrics.count("idempotent_replay")).toBeGreaterThan(0);
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("uppercase UUIDs are the same identifiers: normalized before the hash → replay", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const command = wagerCommand(wallet, "BET", { amount: "25.00" });
      const first = await suite().app.processWagerTransaction.execute(command, CTX);
      const upper = {
        ...command,
        walletId: command.walletId.toUpperCase(),
        playerId: command.playerId.toUpperCase(),
      };
      const replay = await suite().app.processWagerTransaction.execute(upper, CTX);
      expect(first.status).toBe(WagerTransactionStatus.Processed);
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "75.00", version: 2 });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("replay of a REJECTED returns the same failureCode and balance", async () => {
      const wallet = await createWallet(suite().app, "10.00");
      const command = wagerCommand(wallet, "BET", { amount: "50.00" });
      const first = await suite().app.processWagerTransaction.execute(command, CTX);
      await submit(wallet, "WIN", { amount: "100.00" }); // now there would be funds
      const replay = await suite().app.processWagerTransaction.execute(command, CTX);
      expect(first).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("replay of a PENDING_REFERENCE", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      const command = wagerCommand(wallet, "ROLLBACK", { reference: "missing-bet" });
      const first = await suite().app.processWagerTransaction.execute(command, CTX);
      const replay = await suite().app.processWagerTransaction.execute(command, CTX);
      expect(first.status).toBe(WagerTransactionStatus.PendingReference);
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("same key with a different payload is IDEMPOTENCY_KEY_REUSED, not a replay", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const command = wagerCommand(wallet, "BET", { amount: "10.00" });
      const first = await suite().app.processWagerTransaction.execute(command, CTX);
      const error = await suite()
        .app.processWagerTransaction.execute(
          { ...command, money: { amount: "11.00", currency: "BRL" } },
          CTX,
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdempotencyConflictError);
      expect(error).toMatchObject({
        code: ErrorCode.IdempotencyKeyReused,
        existingTransactionId: first.transactionId,
      });
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "90.00", version: 2 });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("same externalTransactionId under a new key is EXTERNAL_TRANSACTION_ID_CONFLICT", async () => {
      const wallet = await createWallet(suite().app, "100.00");
      const command = wagerCommand(wallet, "BET");
      await suite().app.processWagerTransaction.execute(command, CTX);
      const error = await suite()
        .app.processWagerTransaction.execute({ ...command, idempotencyKey: "another-key" }, CTX)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: ErrorCode.ExternalTransactionIdConflict });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("the same key string from two providers is two different keys", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const a = await submit(wallet, "BET", {
        providerId: "provider-a",
        externalTransactionId: "tx-1",
        idempotencyKey: "shared-key",
      });
      const b = await submit(wallet, "BET", {
        providerId: "provider-b",
        externalTransactionId: "tx-1",
        idempotencyKey: "shared-key",
      });
      expect([a.idempotentReplay, b.idempotentReplay]).toEqual([false, false]);
      expect(a.transactionId).not.toBe(b.transactionId);
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "80.00", version: 3 });
      await assertLedgerInvariant(sql, wallet.id);
    });
  });
});
