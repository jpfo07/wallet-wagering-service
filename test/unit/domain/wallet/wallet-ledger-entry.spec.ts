import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction.ts";
import { WalletLedgerEntry } from "../../../../src/domain/wallet/wallet-ledger-entry.ts";
import type { CreateLedgerEntryProps } from "../../../../src/domain/wallet/wallet-ledger-entry.ts";
import { InvalidLedgerEntryError } from "../../../../src/domain/wallet/wallet.errors.ts";
import { T0, brl, usd } from "../../../support/domain-builders.ts";

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    direction: LedgerDirection.Debit,
    money: brl("25.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("75.00"),
    createdAt: T0,
    ...overrides,
  };
}

describe("WalletLedgerEntry.create", () => {
  test("accepts a balanced debit and a balanced credit", () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl("125.00") }),
    );
    expect(credit.isBalanced()).toBe(true);
  });

  test.each([
    ["unbalanced arithmetic", props({ balanceAfter: brl("75.01") })],
    ["wrong direction for the arithmetic", props({ direction: LedgerDirection.Credit })],
    ["zero amount", props({ money: brl("0.00"), balanceAfter: brl("100.00") })],
    [
      "negative balance after",
      props({ balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(brl("25.00")) }),
    ],
    ["mixed currencies", props({ money: usd("25.00") })],
    ["mixed balance currencies", props({ balanceAfter: usd("75.00") })],
  ])("rejects %s", (_label, invalid) => {
    expect(() => WalletLedgerEntry.create(invalid)).toThrow(InvalidLedgerEntryError);
  });
});

describe("WalletLedgerEntry immutability", () => {
  test("is frozen and has no transition methods", () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: unknown }).balanceAfter = brl("0.00");
    }).toThrow();
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(methods).toEqual(["isBalanced"]);
  });

  test("copies createdAt so the caller cannot mutate it afterwards", () => {
    const createdAt = new Date(T0.getTime());
    const entry = WalletLedgerEntry.create(props({ createdAt }));
    createdAt.setFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe(T0.toISOString());
  });

  test("rehydrate does not revalidate, but isBalanced still tells the truth", () => {
    const corrupted = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl("1.00") }));
    expect(corrupted.isBalanced()).toBe(false);
  });
});
