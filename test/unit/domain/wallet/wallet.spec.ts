import { describe, expect, test } from "bun:test";
import { Money } from "../../../../src/domain/shared/money.ts";
import { CurrencyMismatchError } from "../../../../src/domain/shared/money.errors.ts";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction.ts";
import { Wallet } from "../../../../src/domain/wallet/wallet.ts";
import {
  DuplicateLedgerMovementError,
  InsufficientBalanceError,
  InvalidLedgerEntryError,
  InvalidWalletError,
} from "../../../../src/domain/wallet/wallet.errors.ts";
import { T0, at, brl, newWallet, usd } from "../../../support/domain-builders.ts";

const movement = (transactionId: string, amount: string, offsetMs = 1_000) => ({
  transactionId,
  money: brl(amount),
  ledgerEntryId: `entry-${transactionId}`,
  at: at(offsetMs),
});

describe("Wallet.open", () => {
  test("zero initial balance: version 1, no ledger entry", () => {
    const wallet = newWallet({ balance: "0.00" });
    expect(wallet.balance.amount).toBe("0.00");
    expect(wallet.version).toBe(1);
    expect(wallet.pullNewLedgerEntries()).toEqual([]);
  });

  test("positive initial balance: one OPENING CREDIT 0 → 100 and version still 1", () => {
    const wallet = newWallet({ balance: "100.00" });
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    const [entry, ...rest] = wallet.pullNewLedgerEntries();
    expect(rest).toEqual([]);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.transactionId).toBe("opening-wallet-1");
    expect(entry?.balanceBefore.amount).toBe("0.00");
    expect(entry?.balanceAfter.amount).toBe("100.00");
    expect(entry?.walletVersion).toBe(1);
  });

  test("the currency comes from the initial balance", () => {
    expect(newWallet({ balance: "5.00", currency: "USD" }).currency).toBe("USD");
  });

  test.each([
    [
      "positive balance without OPENING",
      () => Wallet.open({ id: "w", playerId: "p", initialBalance: brl("1.00"), at: T0 }),
    ],
    [
      "zero balance with OPENING",
      () =>
        Wallet.open({
          id: "w",
          playerId: "p",
          initialBalance: brl("0.00"),
          at: T0,
          opening: { transactionId: "t", ledgerEntryId: "e" },
        }),
    ],
    [
      "negative balance",
      () =>
        Wallet.open({
          id: "w",
          playerId: "p",
          initialBalance: brl("0.00").subtract(brl("1.00")),
          at: T0,
        }),
    ],
  ])("rejects %s", (_label, open) => {
    expect(open).toThrow(InvalidWalletError);
  });
});

describe("Wallet debit/credit", () => {
  test("debit moves balance, bumps version, sets updatedAt and returns the matching entry", () => {
    const wallet = newWallet();
    wallet.pullNewLedgerEntries();
    const entry = wallet.debit(movement("bet-1", "25.00"));
    expect(wallet.balance.amount).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(at(1_000));
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("75.00");
    expect(entry.walletVersion).toBe(2);
    expect(wallet.pullNewLedgerEntries()).toEqual([entry]);
  });

  test("credit moves balance up and bumps version", () => {
    const wallet = newWallet();
    const entry = wallet.credit(movement("win-1", "50.00"));
    expect(wallet.balance.amount).toBe("150.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test("first movement of a wallet opened with zero carries walletVersion 2 (no entry at 1)", () => {
    const wallet = newWallet({ balance: "0.00" });
    const entry = wallet.credit(movement("win-1", "50.00"));
    expect(entry.walletVersion).toBe(2);
    expect(entry.walletVersion).toBe(wallet.version);
  });

  test("debiting the exact balance reaches zero", () => {
    const wallet = newWallet();
    wallet.debit(movement("bet-1", "100.00"));
    expect(wallet.balance.amount).toBe("0.00");
    expect(wallet.canDebit(brl("0.01"))).toBe(false);
  });

  test("canDebit", () => {
    const wallet = newWallet();
    expect(wallet.canDebit(brl("100.00"))).toBe(true);
    expect(wallet.canDebit(brl("100.01"))).toBe(false);
  });

  test.each([
    [
      "debit beyond the balance",
      (w: Wallet) => w.debit(movement("bet-1", "100.01")),
      InsufficientBalanceError,
    ],
    ["zero debit", (w: Wallet) => w.debit(movement("bet-1", "0.00")), InvalidLedgerEntryError],
    ["zero credit", (w: Wallet) => w.credit(movement("win-1", "0.00")), InvalidLedgerEntryError],
    [
      "debit in another currency",
      (w: Wallet) => w.debit({ ...movement("bet-1", "1.00"), money: usd("1.00") }),
      CurrencyMismatchError,
    ],
    [
      "credit in another currency",
      (w: Wallet) => w.credit({ ...movement("win-1", "1.00"), money: usd("1.00") }),
      CurrencyMismatchError,
    ],
    ["canDebit in another currency", (w: Wallet) => w.canDebit(usd("1.00")), CurrencyMismatchError],
  ])("%s throws and leaves the wallet untouched", (_label, operation, errorType) => {
    const wallet = newWallet();
    wallet.pullNewLedgerEntries();
    expect(() => operation(wallet)).toThrow(errorType);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
    expect(wallet.pullNewLedgerEntries()).toEqual([]);
  });

  test("one movement per transaction per wallet", () => {
    const wallet = newWallet();
    wallet.debit(movement("bet-1", "10.00"));
    expect(() => wallet.credit(movement("bet-1", "10.00", 2_000))).toThrow(
      DuplicateLedgerMovementError,
    );
    expect(wallet.balance.amount).toBe("90.00");
  });

  test("pullNewLedgerEntries drains the list", () => {
    const wallet = newWallet();
    wallet.debit(movement("bet-1", "10.00"));
    expect(wallet.pullNewLedgerEntries()).toHaveLength(2);
    expect(wallet.pullNewLedgerEntries()).toHaveLength(0);
  });
});

describe("Wallet balance == balance rebuilt from its ledger", () => {
  test("after a mixed sequence, every entry chains and the sum matches", () => {
    const wallet = newWallet({ balance: "100.00" });
    wallet.debit(movement("bet-1", "80.00", 1_000));
    wallet.credit(movement("win-1", "45.50", 2_000));
    wallet.debit(movement("bet-2", "65.50", 3_000));
    wallet.credit(movement("refund-1", "0.01", 4_000));
    const entries = wallet.pullNewLedgerEntries();

    const rebuilt = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      Money.zero("BRL"),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe("0.01");
    expect(wallet.version).toBe(5);
    expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4, 5]);
    for (let index = 1; index < entries.length; index += 1) {
      expect(
        entries[index]?.balanceBefore.equals(entries[index - 1]?.balanceAfter ?? brl("0.00")),
      ).toBe(true);
    }
  });
});

describe("Wallet.rehydrate", () => {
  test("rebuilds the persisted state without revalidating", () => {
    const wallet = Wallet.rehydrate({
      id: "w",
      playerId: "p",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: T0,
      updatedAt: at(5_000),
    });
    expect(wallet.balance.amount).toBe("42.00");
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(at(5_000));
    expect(wallet.pullNewLedgerEntries()).toEqual([]);
  });
});
