import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../../../src/domain/shared/failure-code.ts";
import { InvalidMoneyError } from "../../../../src/domain/shared/money.errors.ts";
import { WagerTransactionStatus } from "../../../../src/domain/wager/wager-transaction-status.ts";
import {
  moneyFromColumns,
  moneyToColumns,
  optionalMoneyFromColumns,
} from "../../../../src/infrastructure/persistence/mappers/money-columns.ts";
import { PersistenceMappingError } from "../../../../src/infrastructure/persistence/mappers/persistence-mapping.error.ts";
import { WagerTransactionMapper } from "../../../../src/infrastructure/persistence/mappers/wager-transaction.mapper.ts";
import { WalletLedgerEntryMapper } from "../../../../src/infrastructure/persistence/mappers/wallet-ledger-entry.mapper.ts";
import { WalletMapper } from "../../../../src/infrastructure/persistence/mappers/wallet.mapper.ts";
import type { WagerTransactionRow } from "../../../../src/infrastructure/persistence/models/wager-transaction.model.ts";
import { T0, brl, newWallet, wager } from "../../../support/domain-builders.ts";
import { WagerTransactionKind } from "../../../../src/domain/wager/wager-transaction-kind.ts";

describe("money columns", () => {
  test("string in, string out: never through number", () => {
    const money = moneyFromColumns("999999999999999999.99", "BRL");
    expect(moneyToColumns(money)).toEqual({ amount: "999999999999999999.99", currency: "BRL" });
    expect(moneyToColumns(moneyFromColumns("0.10", "BRL")).amount).toBe("0.10");
  });

  test("a corrupted amount fails loudly instead of becoming an invalid Money", () => {
    expect(() => moneyFromColumns("25", "BRL")).toThrow(InvalidMoneyError);
    expect(() => moneyFromColumns("-1.00", "BRL")).toThrow(InvalidMoneyError);
  });

  test("optional money: both null → undefined; half null → error", () => {
    expect(optionalMoneyFromColumns(null, null)).toBeUndefined();
    expect(optionalMoneyFromColumns(undefined, undefined)).toBeUndefined();
    expect(() => optionalMoneyFromColumns("1.00", null)).toThrow(PersistenceMappingError);
    expect(() => optionalMoneyFromColumns(null, "BRL")).toThrow(PersistenceMappingError);
  });
});

describe("WalletMapper and WalletLedgerEntryMapper", () => {
  test("row ↔ domain is lossless", () => {
    const wallet = newWallet({ balance: "100.00" });
    const [entry] = wallet.pullNewLedgerEntries();
    if (entry === undefined) throw new Error("expected the opening entry");
    const row = WalletMapper.toRow(wallet);
    expect(row.balance).toBe("100.00");
    expect(WalletMapper.toRow(WalletMapper.toDomain(row))).toEqual(row);

    const entryRow = WalletLedgerEntryMapper.toRow(entry);
    expect(entryRow).toMatchObject({
      direction: "CREDIT",
      walletVersion: 1,
      balanceAfter: "100.00",
    });
    const back = WalletLedgerEntryMapper.toDomain(entryRow);
    expect(back.isBalanced()).toBe(true);
    expect(WalletLedgerEntryMapper.toRow(back)).toEqual(entryRow);
  });

  test("unknown direction is refused", () => {
    const wallet = newWallet({ balance: "100.00" });
    const [entry] = wallet.pullNewLedgerEntries();
    if (entry === undefined) throw new Error("expected the opening entry");
    const row = { ...WalletLedgerEntryMapper.toRow(entry), direction: "SIDEWAYS" };
    expect(() => WalletLedgerEntryMapper.toDomain(row)).toThrow(PersistenceMappingError);
  });
});

describe("WagerTransactionMapper", () => {
  const pending = (): WagerTransactionRow => {
    const tx = wager(WagerTransactionKind.Refund, { reference: "bet-1" });
    tx.markPendingReference({
      observedBalance: brl("100.00"),
      nextCheckAt: T0,
      expiresAt: new Date(T0.getTime() + 60_000),
      at: T0,
    });
    return WagerTransactionMapper.toRow(tx);
  };

  test("undefined becomes null in the row and back", () => {
    const tx = wager(WagerTransactionKind.Bet);
    tx.fail({ code: FailureCode.InternalPermanentError, at: T0 });
    const row = WagerTransactionMapper.toRow(tx);
    expect(row).toMatchObject({
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      processedAt: null,
      observedBalanceAmount: null,
      observedBalanceCurrency: null,
      nextReferenceCheckAt: null,
      referenceExpiresAt: null,
    });
    const back = WagerTransactionMapper.toDomain(row);
    expect(back.status).toBe(WagerTransactionStatus.Failed);
    expect(back.observedBalance).toBeUndefined();
    expect(WagerTransactionMapper.toRow(back)).toEqual(row);
  });

  test("PENDING_REFERENCE keeps its schedule and observed balance", () => {
    const row = pending();
    const back = WagerTransactionMapper.toDomain(row);
    expect(back.status).toBe(WagerTransactionStatus.PendingReference);
    expect(back.observedBalance?.amount).toBe("100.00");
    expect(back.referenceExpiresAt?.toISOString()).toBe(
      new Date(T0.getTime() + 60_000).toISOString(),
    );
    expect(WagerTransactionMapper.toRow(back)).toEqual(row);
  });

  test.each<[string, Partial<WagerTransactionRow>]>([
    ["unknown kind", { kind: "JACKPOT" }],
    ["unknown status", { status: "PENDING_FOREVER" }],
    ["unknown failure code", { failureCode: "OOPS" }],
    ["half-null observed balance", { observedBalanceCurrency: null }],
  ])("%s is refused", (_label, override) => {
    expect(() => WagerTransactionMapper.toDomain({ ...pending(), ...override })).toThrow(
      PersistenceMappingError,
    );
  });
});
