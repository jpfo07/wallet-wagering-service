import { describe, expect, test } from "bun:test";
import type { EventContext } from "../../../../src/domain/events/integration-event.ts";
import { WagerTransactionFailed } from "../../../../src/domain/events/wager-transaction-failed.ts";
import { WagerTransactionPendingReference } from "../../../../src/domain/events/wager-transaction-pending-reference.ts";
import { WagerTransactionProcessed } from "../../../../src/domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../../../../src/domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../../../../src/domain/events/wallet-balance-changed.ts";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";
import { FailureCode } from "../../../../src/domain/shared/failure-code.ts";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction.ts";
import { WagerTransactionKind as Kind } from "../../../../src/domain/wager/wager-transaction-kind.ts";
import { T0, WagerScenario, at, brl, newWallet, wager } from "../../../support/domain-builders.ts";

const ctx: EventContext = { eventId: "event-1", correlationId: "corr-1", occurredAt: at(5_000) };

/** Every value in the payload must be a JSON primitive or a plain container: no Money, no Date. */
function expectPlainJson(value: unknown): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return;
  }
  expect(typeof value).toBe("object");
  const prototype: unknown = Object.getPrototypeOf(value);
  expect(prototype === Object.prototype || prototype === Array.prototype).toBe(true);
  for (const nested of Object.values(value as object)) {
    expectPlainJson(nested);
  }
}

describe("WalletBalanceChanged", () => {
  const wallet = newWallet();
  const entry = wallet.debit({
    transactionId: "tx-1",
    money: brl("25.00"),
    ledgerEntryId: "entry-1",
    at: at(1_000),
  });
  const event = WalletBalanceChanged.from(wallet, entry, ctx);

  test("envelope shape from the challenge, with MoneyProps strings", () => {
    expect(event.toJSON()).toEqual({
      eventId: "event-1",
      eventType: "WalletBalanceChanged",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      occurredAt: "2026-07-29T15:00:05.000Z",
      version: 1,
      data: {
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("causationId is omitted when absent and kept when present", () => {
    expect("causationId" in event.toJSON()).toBe(false);
    const caused = WalletBalanceChanged.from(wallet, entry, { ...ctx, causationId: "msg-1" });
    expect(caused.toJSON().causationId).toBe("msg-1");
  });

  test("payload survives a JSON round trip unchanged and holds no domain instances", () => {
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
    expectPlainJson(event.toJSON());
  });

  test("data is deeply frozen", () => {
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
  });

  test("rejects an entry from another wallet", () => {
    expect(() => WalletBalanceChanged.from(newWallet({ id: "wallet-2" }), entry, ctx)).toThrow(
      InvalidOperationError,
    );
  });
});

describe("WagerTransaction* events", () => {
  test("Processed (including LOSS): observed balance and processedAt", () => {
    const scenario = new WagerScenario();
    scenario.submit(Kind.Bet, "bet");
    const { transaction } = scenario.submit(Kind.Loss, "loss", {
      money: brl("0.00"),
      reference: "bet",
    });
    const json = WagerTransactionProcessed.from(transaction, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.aggregateId).toBe("wallet-1");
    expect(json.data).toMatchObject({
      transactionId: transaction.id,
      kind: Kind.Loss,
      money: { amount: "0.00", currency: "BRL" },
      referenceExternalTransactionId: "bet",
      referenceTransactionId: "tx-bet",
      balance: { amount: "90.00", currency: "BRL" },
      processedAt: transaction.processedAt?.toISOString(),
    });
    expectPlainJson(json);
  });

  test("Rejected carries the failureCode and the observed balance", () => {
    const scenario = new WagerScenario({ balance: "10.00" });
    const { transaction } = scenario.submit(Kind.Bet, "bet", { money: brl("20.00") });
    const json = WagerTransactionRejected.from(transaction, ctx).toJSON();
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(json.data.balance).toEqual({ amount: "10.00", currency: "BRL" });
    expect("referenceTransactionId" in json.data).toBe(false);
  });

  test("PendingReference carries the reference and the expiry", () => {
    const scenario = new WagerScenario();
    const { transaction } = scenario.submit(Kind.Refund, "refund", { reference: "bet" });
    const json = WagerTransactionPendingReference.from(transaction, ctx).toJSON();
    expect(json.data.referenceExternalTransactionId).toBe("bet");
    expect(json.data.referenceExpiresAt).toBe(
      transaction.referenceExpiresAt?.toISOString() ?? "missing expiry",
    );
  });

  test("Failed carries INTERNAL_PERMANENT_ERROR", () => {
    const tx = wager(Kind.Bet);
    tx.fail({ code: FailureCode.InternalPermanentError, at: T0 });
    expect(WagerTransactionFailed.from(tx, ctx).toJSON().data.failureCode).toBe(
      FailureCode.InternalPermanentError,
    );
  });

  test.each([
    ["Processed", (tx: ReturnType<typeof wager>) => WagerTransactionProcessed.from(tx, ctx)],
    ["Rejected", (tx: ReturnType<typeof wager>) => WagerTransactionRejected.from(tx, ctx)],
    [
      "PendingReference",
      (tx: ReturnType<typeof wager>) => WagerTransactionPendingReference.from(tx, ctx),
    ],
    ["Failed", (tx: ReturnType<typeof wager>) => WagerTransactionFailed.from(tx, ctx)],
  ])("%s refuses a transaction in the wrong status", (_name, build) => {
    expect(() => build(wager(Kind.Bet))).toThrow(InvalidOperationError);
  });

  test("eventType and version are fixed per class", () => {
    const tx = wager(Kind.Bet);
    tx.fail({ code: FailureCode.InternalPermanentError, at: T0 });
    const failed = WagerTransactionFailed.from(tx, ctx);
    expect(failed.eventType).toBe("WagerTransactionFailed");
    expect(failed.version).toBe(1);
  });
});
