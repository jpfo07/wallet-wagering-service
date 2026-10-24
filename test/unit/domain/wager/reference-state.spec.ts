import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../../../src/domain/shared/failure-code.ts";
import {
  InvalidReferenceStateError,
  ReferenceState,
} from "../../../../src/domain/wager/reference-state.ts";
import { WagerTransactionKind as Kind } from "../../../../src/domain/wager/wager-transaction-kind.ts";
import type { WagerTransaction } from "../../../../src/domain/wager/wager-transaction.ts";
import { at, brl, wager } from "../../../support/domain-builders.ts";

const bet = processed(wager(Kind.Bet, { externalTransactionId: "bet" }), undefined);

function processed(
  tx: WagerTransaction,
  referenceTransactionId: string | undefined,
): WagerTransaction {
  tx.markProcessed({ referenceTransactionId, observedBalance: brl("0.00"), at: at(1) });
  return tx;
}

function dependent(kind: Kind, ext: string, target: WagerTransaction): WagerTransaction {
  return processed(
    wager(kind, { externalTransactionId: ext, reference: target.externalTransactionId }),
    target.id,
  );
}

const rollbackOf = (target: WagerTransaction, ext: string) => dependent(Kind.Rollback, ext, target);

function evaluate(dependents: WagerTransaction[], dependentRollbacks: WagerTransaction[] = []) {
  const state = ReferenceState.evaluate({ reference: bet, dependents, dependentRollbacks });
  return {
    everReversed: state.everReversed,
    effectivelyReversed: state.effectivelyReversed,
    hasActiveWin: state.hasActiveWin,
  };
}

describe("ReferenceState.evaluate", () => {
  test("untouched BET", () => {
    expect(evaluate([])).toEqual({
      everReversed: false,
      effectivelyReversed: false,
      hasActiveWin: false,
    });
  });

  test("BET ← REFUND: reversed, effectively", () => {
    const refund = dependent(Kind.Refund, "refund", bet);
    expect(evaluate([refund])).toEqual({
      everReversed: true,
      effectivelyReversed: true,
      hasActiveWin: false,
    });
  });

  test("BET ← ROLLBACK: reversed, effectively (a ROLLBACK can never be undone)", () => {
    const rollback = dependent(Kind.Rollback, "rollback", bet);
    expect(evaluate([rollback])).toEqual({
      everReversed: true,
      effectivelyReversed: true,
      hasActiveWin: false,
    });
  });

  test("BET ← REFUND ← ROLLBACK: ever reversed, but no longer effectively", () => {
    const refund = dependent(Kind.Refund, "refund", bet);
    const undo = rollbackOf(refund, "rollback-refund");
    expect(evaluate([refund], [undo])).toEqual({
      everReversed: true,
      effectivelyReversed: false,
      hasActiveWin: false,
    });
  });

  test("BET ← WIN: active win", () => {
    const win = dependent(Kind.Win, "win", bet);
    expect(evaluate([win])).toEqual({
      everReversed: false,
      effectivelyReversed: false,
      hasActiveWin: true,
    });
  });

  test("BET ← WIN ← ROLLBACK: the win is no longer active", () => {
    const win = dependent(Kind.Win, "win", bet);
    expect(evaluate([win], [rollbackOf(win, "rollback-win")])).toEqual({
      everReversed: false,
      effectivelyReversed: false,
      hasActiveWin: false,
    });
  });

  test("two WINs, one undone: still an active win", () => {
    const win1 = dependent(Kind.Win, "win-1", bet);
    const win2 = dependent(Kind.Win, "win-2", bet);
    expect(evaluate([win1, win2], [rollbackOf(win1, "rollback-win-1")]).hasActiveWin).toBe(true);
  });

  test("LOSS is ignored: it never moved the balance", () => {
    const loss = dependent(Kind.Loss, "loss", bet);
    expect(evaluate([loss])).toEqual({
      everReversed: false,
      effectivelyReversed: false,
      hasActiveWin: false,
    });
  });

  test("keeps the referenced transaction", () => {
    expect(
      ReferenceState.evaluate({ reference: bet, dependents: [], dependentRollbacks: [] })
        .transaction,
    ).toBe(bet);
  });
});

describe("ReferenceState.notFound", () => {
  test("has no transaction and no history", () => {
    const state = ReferenceState.notFound();
    expect(state.transaction).toBeUndefined();
    expect(state.everReversed).toBe(false);
    expect(state.effectivelyReversed).toBe(false);
    expect(state.hasActiveWin).toBe(false);
  });
});

describe("ReferenceState rejects incoherent input (bug in whoever loaded it)", () => {
  const otherBet = processed(wager(Kind.Bet, { externalTransactionId: "other-bet" }), undefined);

  test.each([
    ["dependent of another reference", () => evaluate([dependent(Kind.Refund, "r", otherBet)])],
    [
      "non-PROCESSED dependent",
      () => evaluate([wager(Kind.Refund, { externalTransactionId: "r", reference: "bet" })]),
    ],
    [
      "rejected dependent",
      () => {
        const rejected = wager(Kind.Refund, { externalTransactionId: "r", reference: "bet" });
        rejected.reject({
          code: FailureCode.AmountMismatch,
          observedBalance: brl("0.00"),
          at: at(1),
        });
        return evaluate([rejected]);
      },
    ],
    [
      "rollback of something that is not a dependent",
      () => evaluate([], [rollbackOf(dependent(Kind.Refund, "r", otherBet), "rb")]),
    ],
    [
      "dependent rollback that is not a ROLLBACK",
      () => {
        const refund = dependent(Kind.Refund, "refund", bet);
        return evaluate([refund], [dependent(Kind.Win, "w", refund)]);
      },
    ],
  ])("%s", (_label, run) => {
    expect(run).toThrow(InvalidReferenceStateError);
  });
});
