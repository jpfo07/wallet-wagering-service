import { describe, expect, test } from "bun:test";
import { computeWagerPayloadHash } from "../../../../src/domain/idempotency/payload-hash.ts";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";
import { ErrorCode } from "../../../../src/domain/shared/failure-code.ts";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction.ts";
import { WagerTransactionKind as Kind } from "../../../../src/domain/wager/wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../../../../src/domain/wager/wager-transaction-status.ts";
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
} from "../../../../src/domain/wager/wager-transaction.ts";
import { InvalidWagerTransactionError } from "../../../../src/domain/wager/wager-transaction.errors.ts";
import type { WagerOverrides } from "../../../support/domain-builders.ts";
import { T0, brl, wager } from "../../../support/domain-builders.ts";

function validationCode(kind: Kind, overrides: WagerOverrides): string | undefined {
  try {
    wager(kind, overrides);
  } catch (error) {
    if (error instanceof InvalidWagerTransactionError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

describe("WagerTransaction.create", () => {
  test("is born PENDING with no outcome", () => {
    const bet = wager(Kind.Bet);
    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.failureCode).toBeUndefined();
    expect(bet.processedAt).toBeUndefined();
    expect(bet.observedBalance).toBeUndefined();
    expect(bet.referenceTransactionId).toBeUndefined();
    expect(bet.isTerminal()).toBe(false);
  });

  test.each([
    [Kind.Bet, {}],
    [Kind.Win, {}],
    [Kind.Win, { reference: "ext-bet" }],
    [Kind.Loss, {}],
    [Kind.Loss, { reference: "ext-bet" }],
    [Kind.Loss, { money: brl("0.00") }],
    [Kind.Refund, { reference: "ext-bet" }],
    [Kind.Rollback, { reference: "ext-bet" }],
  ])("accepts %s %p", (kind, overrides) => {
    expect(validationCode(kind, overrides)).toBeUndefined();
  });

  test.each([
    ["OPENING is internal", Kind.Opening, {}, ErrorCode.KindNotAllowed],
    ["REFUND without reference", Kind.Refund, {}, ErrorCode.ReferenceRequired],
    ["ROLLBACK without reference", Kind.Rollback, {}, ErrorCode.ReferenceRequired],
    ["BET with reference", Kind.Bet, { reference: "ext-other" }, ErrorCode.ReferenceNotAllowed],
    [
      "self reference",
      Kind.Refund,
      { externalTransactionId: "ext-1", reference: "ext-1" },
      ErrorCode.SelfReference,
    ],
    ["empty reference", Kind.Refund, { reference: "  " }, ErrorCode.InvalidPayload],
    ["BET of zero", Kind.Bet, { money: brl("0.00") }, ErrorCode.InvalidAmount],
    ["WIN of zero", Kind.Win, { money: brl("0.00") }, ErrorCode.InvalidAmount],
    [
      "REFUND of zero",
      Kind.Refund,
      { money: brl("0.00"), reference: "b" },
      ErrorCode.InvalidAmount,
    ],
    [
      "ROLLBACK of zero",
      Kind.Rollback,
      { money: brl("0.00"), reference: "b" },
      ErrorCode.InvalidAmount,
    ],
    [
      "negative LOSS",
      Kind.Loss,
      { money: brl("0.00").subtract(brl("1.00")) },
      ErrorCode.InvalidAmount,
    ],
    [
      "reserved provider",
      Kind.Bet,
      { providerId: INTERNAL_PROVIDER_ID },
      ErrorCode.ProviderReserved,
    ],
    ["empty roundId", Kind.Bet, { roundId: "" }, ErrorCode.InvalidPayload],
    ["blank playerId", Kind.Bet, { playerId: "   " }, ErrorCode.InvalidPayload],
  ])("rejects %s", (_label, kind, overrides, code) => {
    expect(validationCode(kind, overrides)).toBe(code);
  });

  test("rejects an unknown kind coming from an untyped boundary", () => {
    expect(validationCode("JACKPOT" as unknown as Kind, {})).toBe(ErrorCode.InvalidPayload);
  });

  test("rejects a payload hash that is not a SHA-256 hex (programming error)", () => {
    const fields = {
      id: "t",
      providerId: "p",
      externalTransactionId: "e",
      idempotencyKey: "k",
      walletId: "w",
      playerId: "pl",
      roundId: "r",
      gameId: "g",
      kind: Kind.Bet,
      money: brl("1.00"),
      createdAt: T0,
    };
    expect(() => WagerTransaction.create({ ...fields, payloadHash: "abc" })).toThrow(
      InvalidOperationError,
    );
  });
});

describe("WagerTransaction.opening", () => {
  test("is an internal, already PROCESSED credit with reserved identifiers", () => {
    const opening = WagerTransaction.opening({
      id: "tx-open",
      walletId: "wallet-9",
      playerId: "player-9",
      money: brl("1000.00"),
      at: T0,
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(opening.externalTransactionId).toBe("opening:wallet-9");
    expect(opening.idempotencyKey).toBe("internal:opening:wallet-9");
    expect(opening.observedBalance?.amount).toBe("1000.00");
    expect(opening.processedAt).toEqual(T0);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(opening.payloadHash).toBe(
      computeWagerPayloadHash({
        providerId: INTERNAL_PROVIDER_ID,
        externalTransactionId: "opening:wallet-9",
        playerId: "player-9",
        walletId: "wallet-9",
        roundId: "opening",
        gameId: "opening",
        kind: Kind.Opening,
        money: brl("1000.00"),
      }),
    );
  });

  test("requires a positive amount", () => {
    expect(() =>
      WagerTransaction.opening({
        id: "t",
        walletId: "w",
        playerId: "p",
        money: brl("0.00"),
        at: T0,
      }),
    ).toThrow(InvalidOperationError);
  });
});

describe("WagerTransaction domain queries", () => {
  test.each([
    [Kind.Bet, true, false, false],
    [Kind.Win, true, false, true],
    [Kind.Loss, false, false, true],
    [Kind.Refund, true, true, true],
    [Kind.Rollback, true, true, true],
  ])(
    "%s: affectsBalance=%p requiresReference=%p acceptsReference=%p",
    (kind, affects, requires, accepts) => {
      const reference = requires ? { reference: "ext-bet" } : {};
      const tx = wager(kind, reference);
      expect(tx.affectsBalance()).toBe(affects);
      expect(tx.requiresReference()).toBe(requires);
      expect(tx.acceptsReference()).toBe(accepts);
    },
  );

  test("allowed reference kinds", () => {
    expect(wager(Kind.Bet).allowedReferenceKinds()).toEqual([]);
    expect(wager(Kind.Win).allowedReferenceKinds()).toEqual([Kind.Bet]);
    expect(wager(Kind.Loss).allowedReferenceKinds()).toEqual([Kind.Bet]);
    expect(wager(Kind.Refund, { reference: "b" }).allowedReferenceKinds()).toEqual([Kind.Bet]);
    expect(wager(Kind.Rollback, { reference: "b" }).allowedReferenceKinds()).toEqual([
      Kind.Bet,
      Kind.Win,
      Kind.Refund,
    ]);
  });

  test("matchesPayload compares the stored hash", () => {
    const bet = wager(Kind.Bet);
    expect(bet.matchesPayload(bet.payloadHash)).toBe(true);
    expect(bet.matchesPayload(wager(Kind.Bet, { money: brl("10.01") }).payloadHash)).toBe(false);
  });
});

describe("WagerTransaction.ledgerDirectionFor", () => {
  const bet = wager(Kind.Bet);
  const win = wager(Kind.Win);
  const refund = wager(Kind.Refund, { reference: "ext-bet" });
  const loss = wager(Kind.Loss);
  const rollback = wager(Kind.Rollback, { reference: "ext-x" });

  test("BET debits; WIN and REFUND credit", () => {
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverts its reference: BET → CREDIT, WIN → DEBIT, REFUND → DEBIT", () => {
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test.each([
    ["LOSS", () => loss.ledgerDirectionFor()],
    ["ROLLBACK without reference", () => rollback.ledgerDirectionFor()],
    ["ROLLBACK of ROLLBACK", () => rollback.ledgerDirectionFor(rollback)],
    ["ROLLBACK of LOSS", () => rollback.ledgerDirectionFor(loss)],
  ])("%s has no direction (programming error)", (_label, call) => {
    expect(call).toThrow(InvalidOperationError);
  });
});
