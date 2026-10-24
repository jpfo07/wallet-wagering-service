import { afterEach, describe, expect, test } from "bun:test";
import { addMilliseconds as addMillisecondsTo } from "../../../../src/domain/shared/backoff-policy.ts";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";
import { FailureCode as Code } from "../../../../src/domain/shared/failure-code.ts";
import type { RejectionCode } from "../../../../src/domain/shared/failure-code.ts";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction.ts";
import { ReferenceState } from "../../../../src/domain/wager/reference-state.ts";
import { settleWager } from "../../../../src/domain/wager/wager-settlement.ts";
import { WagerTransactionKind as Kind } from "../../../../src/domain/wager/wager-transaction-kind.ts";
import { WagerTransactionStatus as Status } from "../../../../src/domain/wager/wager-transaction-status.ts";
import type { Submitted } from "../../../support/domain-builders.ts";
import {
  RETRY,
  WagerScenario,
  brl,
  newWallet,
  usd,
  wager,
} from "../../../support/domain-builders.ts";

const { Bet, Win, Loss, Refund, Rollback } = Kind;

let scenario: WagerScenario;

function start(balance = "100.00"): WagerScenario {
  scenario = new WagerScenario({ balance });
  return scenario;
}

afterEach(() => {
  // Invariant closing every scenario: wallet.balance == balance rebuilt from the ledger.
  expect(scenario.ledgerBalance().equals(scenario.wallet.balance)).toBe(true);
});

function expectProcessed(submitted: Submitted, direction?: LedgerDirection): void {
  expect(submitted.outcome.status).toBe(Status.Processed);
  expect(submitted.transaction.status).toBe(Status.Processed);
  if (submitted.outcome.status !== Status.Processed) {
    return;
  }
  expect(submitted.outcome.ledgerEntry?.direction).toBe(direction);
  expect(submitted.transaction.observedBalance?.equals(scenario.wallet.balance)).toBe(true);
}

function expectRejected(submitted: Submitted, code: RejectionCode): void {
  expect(submitted.outcome).toEqual({ status: Status.Rejected, failureCode: code });
  expect(submitted.transaction.status).toBe(Status.Rejected);
  expect(submitted.transaction.failureCode).toBe(code);
  expect(submitted.transaction.observedBalance?.equals(scenario.wallet.balance)).toBe(true);
}

/** A rejection must leave balance, version and ledger exactly as they were. */
function expectUntouched(run: () => Submitted, code: RejectionCode): void {
  const balance = scenario.wallet.balance;
  const version = scenario.wallet.version;
  const entries = scenario.ledger.length;
  expectRejected(run(), code);
  expect(scenario.wallet.balance.equals(balance)).toBe(true);
  expect(scenario.wallet.version).toBe(version);
  expect(scenario.ledger.length).toBe(entries);
}

describe("BET", () => {
  test("debits the stake", () => {
    start();
    const bet = scenario.submit(Bet, "bet", { money: brl("25.00") });
    expectProcessed(bet, LedgerDirection.Debit);
    expect(scenario.wallet.balance.amount).toBe("75.00");
    expect(scenario.wallet.version).toBe(2);
    expect(bet.transaction.observedBalance?.amount).toBe("75.00");
  });

  test("the exact balance is enough", () => {
    start();
    expectProcessed(scenario.submit(Bet, "bet", { money: brl("100.00") }), LedgerDirection.Debit);
    expect(scenario.wallet.balance.amount).toBe("0.00");
  });

  test("without funds → INSUFFICIENT_FUNDS, nothing moves", () => {
    start();
    expectUntouched(
      () => scenario.submit(Bet, "bet", { money: brl("100.01") }),
      Code.InsufficientFunds,
    );
  });

  test("100.00 with two BETs of 80.00 → one PROCESSED, one INSUFFICIENT_FUNDS, balance 20.00, one DEBIT", () => {
    start("100.00");
    expectProcessed(scenario.submit(Bet, "bet-1", { money: brl("80.00") }), LedgerDirection.Debit);
    expectRejected(scenario.submit(Bet, "bet-2", { money: brl("80.00") }), Code.InsufficientFunds);
    expect(scenario.wallet.balance.amount).toBe("20.00");
    expect(
      scenario.ledger.filter((entry) => entry.direction === LedgerDirection.Debit),
    ).toHaveLength(1);
  });
});

describe("WIN", () => {
  test("without reference credits the prize", () => {
    start();
    expectProcessed(scenario.submit(Win, "win", { money: brl("50.00") }), LedgerDirection.Credit);
    expect(scenario.wallet.balance.amount).toBe("150.00");
  });

  test("with a processed BET of the same round credits and records the reference", () => {
    start();
    const bet = scenario.submit(Bet, "bet");
    const win = scenario.submit(Win, "win", { money: brl("50.00"), reference: "bet" });
    expectProcessed(win, LedgerDirection.Credit);
    expect(win.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(scenario.wallet.balance.amount).toBe("140.00");
  });

  test("may differ in amount from the BET (it is a prize, not a reversal)", () => {
    start();
    scenario.submit(Bet, "bet", { money: brl("10.00") });
    expectProcessed(
      scenario.submit(Win, "win", { money: brl("0.01"), reference: "bet" }),
      LedgerDirection.Credit,
    );
  });

  test("several WINs for the same BET are all accepted (decision 21)", () => {
    start();
    scenario.submit(Bet, "bet", { money: brl("10.00") });
    expectProcessed(
      scenario.submit(Win, "win-1", { money: brl("5.00"), reference: "bet" }),
      LedgerDirection.Credit,
    );
    expectProcessed(
      scenario.submit(Win, "win-2", { money: brl("7.00"), reference: "bet" }),
      LedgerDirection.Credit,
    );
    expect(scenario.wallet.balance.amount).toBe("102.00");
  });

  test("referencing a WIN → REFERENCE_KIND_NOT_ALLOWED", () => {
    start();
    scenario.submit(Win, "win-1");
    expectUntouched(
      () => scenario.submit(Win, "win-2", { reference: "win-1" }),
      Code.ReferenceKindNotAllowed,
    );
  });
});

describe("LOSS", () => {
  test("is PROCESSED without a ledger entry and without bumping the version", () => {
    start();
    scenario.submit(Bet, "bet");
    const version = scenario.wallet.version;
    const entries = scenario.ledger.length;
    const loss = scenario.submit(Loss, "loss", { money: brl("0.00"), reference: "bet" });
    expectProcessed(loss, undefined);
    expect(scenario.wallet.version).toBe(version);
    expect(scenario.ledger.length).toBe(entries);
    expect(scenario.wallet.balance.amount).toBe("90.00");
  });

  test("without reference is accepted too", () => {
    start();
    expectProcessed(scenario.submit(Loss, "loss"), undefined);
  });

  test("a non-zero LOSS still does not move the balance", () => {
    start();
    expectProcessed(scenario.submit(Loss, "loss", { money: brl("10.00") }), undefined);
    expect(scenario.wallet.balance.amount).toBe("100.00");
  });
});

describe("REFUND", () => {
  test("of a processed BET credits the same amount", () => {
    start();
    const bet = scenario.submit(Bet, "bet", { money: brl("30.00") });
    const refund = scenario.submit(Refund, "refund", { money: brl("30.00"), reference: "bet" });
    expectProcessed(refund, LedgerDirection.Credit);
    expect(refund.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(scenario.wallet.balance.amount).toBe("100.00");
  });

  test("with a different amount → AMOUNT_MISMATCH (no partial reversal)", () => {
    start();
    scenario.submit(Bet, "bet", { money: brl("30.00") });
    expectUntouched(
      () => scenario.submit(Refund, "refund", { money: brl("29.99"), reference: "bet" }),
      Code.AmountMismatch,
    );
  });

  test("of a WIN → REFERENCE_KIND_NOT_ALLOWED", () => {
    start();
    scenario.submit(Win, "win");
    expectUntouched(
      () => scenario.submit(Refund, "refund", { reference: "win" }),
      Code.ReferenceKindNotAllowed,
    );
  });

  test("twice → REFERENCE_ALREADY_REVERSED", () => {
    start();
    scenario.submit(Bet, "bet");
    expectProcessed(
      scenario.submit(Refund, "refund-1", { reference: "bet" }),
      LedgerDirection.Credit,
    );
    expectUntouched(
      () => scenario.submit(Refund, "refund-2", { reference: "bet" }),
      Code.ReferenceAlreadyReversed,
    );
  });

  test("after a ROLLBACK of the same BET → REFERENCE_ALREADY_REVERSED (decision 1)", () => {
    start();
    scenario.submit(Bet, "bet");
    expectProcessed(
      scenario.submit(Rollback, "rollback", { reference: "bet" }),
      LedgerDirection.Credit,
    );
    expectUntouched(
      () => scenario.submit(Refund, "refund", { reference: "bet" }),
      Code.ReferenceAlreadyReversed,
    );
  });

  test("after a LOSS is accepted (LOSS never moved the balance)", () => {
    start();
    scenario.submit(Bet, "bet");
    scenario.submit(Loss, "loss", { money: brl("0.00"), reference: "bet" });
    expectProcessed(
      scenario.submit(Refund, "refund", { reference: "bet" }),
      LedgerDirection.Credit,
    );
    expect(scenario.wallet.balance.amount).toBe("100.00");
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits", () => {
    start();
    scenario.submit(Bet, "bet");
    expectProcessed(
      scenario.submit(Rollback, "rollback", { reference: "bet" }),
      LedgerDirection.Credit,
    );
    expect(scenario.wallet.balance.amount).toBe("100.00");
  });

  test("of a WIN debits", () => {
    start();
    scenario.submit(Win, "win", { money: brl("50.00") });
    expectProcessed(
      scenario.submit(Rollback, "rollback", { money: brl("50.00"), reference: "win" }),
      LedgerDirection.Debit,
    );
    expect(scenario.wallet.balance.amount).toBe("100.00");
  });

  test("of a REFUND debits", () => {
    start();
    scenario.submit(Bet, "bet");
    scenario.submit(Refund, "refund", { reference: "bet" });
    expectProcessed(
      scenario.submit(Rollback, "rollback", { reference: "refund" }),
      LedgerDirection.Debit,
    );
    expect(scenario.wallet.balance.amount).toBe("90.00");
  });

  test("of a ROLLBACK → REFERENCE_KIND_NOT_ALLOWED", () => {
    start();
    scenario.submit(Bet, "bet");
    scenario.submit(Rollback, "rollback-1", { reference: "bet" });
    expectUntouched(
      () => scenario.submit(Rollback, "rollback-2", { reference: "rollback-1" }),
      Code.ReferenceKindNotAllowed,
    );
  });

  test("of a LOSS → REFERENCE_KIND_NOT_ALLOWED", () => {
    start();
    scenario.submit(Loss, "loss");
    expectUntouched(
      () => scenario.submit(Rollback, "rollback", { reference: "loss" }),
      Code.ReferenceKindNotAllowed,
    );
  });

  test("of the same WIN twice → REFERENCE_ALREADY_REVERSED", () => {
    start();
    scenario.submit(Win, "win");
    expectProcessed(
      scenario.submit(Rollback, "rollback-1", { reference: "win" }),
      LedgerDirection.Debit,
    );
    expectUntouched(
      () => scenario.submit(Rollback, "rollback-2", { reference: "win" }),
      Code.ReferenceAlreadyReversed,
    );
  });

  test("of a WIN already spent → REVERSAL_WOULD_OVERDRAW, distinct from INSUFFICIENT_FUNDS", () => {
    start("0.00");
    scenario.submit(Win, "win", { money: brl("50.00") });
    scenario.submit(Bet, "bet", { money: brl("40.00") });
    expectUntouched(
      () => scenario.submit(Rollback, "rollback", { money: brl("50.00"), reference: "win" }),
      Code.ReversalWouldOverdraw,
    );
    expect(Code.ReversalWouldOverdraw).not.toBe(Code.InsufficientFunds);
  });

  test("of a REFUND already spent → REVERSAL_WOULD_OVERDRAW", () => {
    start("10.00");
    scenario.submit(Bet, "bet", { money: brl("10.00") });
    scenario.submit(Refund, "refund", { money: brl("10.00"), reference: "bet" });
    scenario.submit(Bet, "bet-2", { money: brl("5.00"), roundId: "round-2" });
    expectUntouched(
      () => scenario.submit(Rollback, "rollback", { money: brl("10.00"), reference: "refund" }),
      Code.ReversalWouldOverdraw,
    );
  });

  test("with a different amount → AMOUNT_MISMATCH", () => {
    start();
    scenario.submit(Win, "win", { money: brl("50.00") });
    expectUntouched(
      () => scenario.submit(Rollback, "rollback", { money: brl("5.00"), reference: "win" }),
      Code.AmountMismatch,
    );
  });
});

describe("reversal × settlement (decisions 1, 17, 20)", () => {
  test("BET → REFUND → ROLLBACK of the REFUND → WIN: accepted (the bet is back in play)", () => {
    start();
    scenario.submit(Bet, "bet");
    scenario.submit(Refund, "refund", { reference: "bet" });
    scenario.submit(Rollback, "rollback-refund", { reference: "refund" });
    expectProcessed(
      scenario.submit(Win, "win", { money: brl("50.00"), reference: "bet" }),
      LedgerDirection.Credit,
    );
    expect(scenario.wallet.balance.amount).toBe("140.00");
  });

  test("BET → REFUND → WIN: REFERENCE_ALREADY_REVERSED (no prize for a cancelled bet)", () => {
    start();
    scenario.submit(Bet, "bet");
    scenario.submit(Refund, "refund", { reference: "bet" });
    expectUntouched(
      () => scenario.submit(Win, "win", { reference: "bet" }),
      Code.ReferenceAlreadyReversed,
    );
  });

  test("BET → ROLLBACK → LOSS: REFERENCE_ALREADY_REVERSED", () => {
    start();
    scenario.submit(Bet, "bet");
    scenario.submit(Rollback, "rollback", { reference: "bet" });
    expectUntouched(
      () => scenario.submit(Loss, "loss", { reference: "bet" }),
      Code.ReferenceAlreadyReversed,
    );
  });

  test("BET → REFUND → ROLLBACK of the REFUND → REFUND again: REFERENCE_ALREADY_REVERSED (everReversed)", () => {
    start();
    scenario.submit(Bet, "bet");
    scenario.submit(Refund, "refund-1", { reference: "bet" });
    scenario.submit(Rollback, "rollback-refund", { reference: "refund-1" });
    expectUntouched(
      () => scenario.submit(Refund, "refund-2", { reference: "bet" }),
      Code.ReferenceAlreadyReversed,
    );
  });

  test.each([Refund, Rollback])(
    "BET → WIN → %s of the BET: REFERENCE_HAS_ACTIVE_SETTLEMENT",
    (kind) => {
      start();
      scenario.submit(Bet, "bet", { money: brl("10.00") });
      scenario.submit(Win, "win", { money: brl("50.00"), reference: "bet" });
      expectUntouched(
        () => scenario.submit(kind, "reversal", { money: brl("10.00"), reference: "bet" }),
        Code.ReferenceHasActiveSettlement,
      );
      expect(scenario.wallet.balance.amount).toBe("140.00");
    },
  );

  test("BET → WIN → ROLLBACK of the WIN → REFUND of the BET: accepted", () => {
    start();
    scenario.submit(Bet, "bet", { money: brl("10.00") });
    scenario.submit(Win, "win", { money: brl("50.00"), reference: "bet" });
    expectProcessed(
      scenario.submit(Rollback, "rollback-win", { money: brl("50.00"), reference: "win" }),
      LedgerDirection.Debit,
    );
    expectProcessed(
      scenario.submit(Refund, "refund", { money: brl("10.00"), reference: "bet" }),
      LedgerDirection.Credit,
    );
    expect(scenario.wallet.balance.amount).toBe("100.00");
  });

  test("two WINs, only one rolled back: the BET still has an active settlement", () => {
    start();
    scenario.submit(Bet, "bet");
    scenario.submit(Win, "win-1", { reference: "bet" });
    scenario.submit(Win, "win-2", { reference: "bet" });
    scenario.submit(Rollback, "rollback-win-1", { reference: "win-1" });
    expectUntouched(
      () => scenario.submit(Refund, "refund", { reference: "bet" }),
      Code.ReferenceHasActiveSettlement,
    );
  });
});

describe("reference context (REFERENCE_MISMATCH)", () => {
  /** A processed transaction that was not created through this wallet (other player/wallet/currency). */
  function foreignProcessedBet(overrides: Parameters<typeof wager>[1]): void {
    const bet = wager(Bet, { externalTransactionId: "bet", ...overrides });
    bet.markProcessed({
      referenceTransactionId: undefined,
      observedBalance: bet.money,
      at: scenario.now,
    });
    scenario.transactions.push(bet);
  }

  test("different round", () => {
    start();
    scenario.submit(Bet, "bet");
    expectUntouched(
      () => scenario.submit(Refund, "refund", { roundId: "round-2", reference: "bet" }),
      Code.ReferenceMismatch,
    );
  });

  test("different player", () => {
    start();
    foreignProcessedBet({ playerId: "player-2" });
    expectUntouched(
      () => scenario.submit(Refund, "refund", { reference: "bet" }),
      Code.ReferenceMismatch,
    );
  });

  test("different wallet", () => {
    start();
    foreignProcessedBet({ walletId: "wallet-2" });
    expectUntouched(
      () => scenario.submit(Refund, "refund", { reference: "bet" }),
      Code.ReferenceMismatch,
    );
  });

  test("different currency", () => {
    start();
    foreignProcessedBet({ money: usd("10.00") });
    expectUntouched(
      () => scenario.submit(Refund, "refund", { reference: "bet" }),
      Code.ReferenceMismatch,
    );
  });

  test("mismatch is checked before the kind (fixed order)", () => {
    start();
    scenario.submit(Win, "win");
    expectRejected(
      scenario.submit(Refund, "refund", { roundId: "round-2", reference: "win" }),
      Code.ReferenceMismatch,
    );
  });

  test("another provider never finds the reference: it waits as PENDING_REFERENCE", () => {
    start();
    scenario.submit(Bet, "bet");
    const refund = scenario.submit(Refund, "refund", {
      providerId: "provider-b",
      reference: "bet",
    });
    expect(refund.outcome.status).toBe(Status.PendingReference);
  });
});

describe("wallet checks", () => {
  test("transaction of another player → WALLET_PLAYER_MISMATCH", () => {
    start();
    expectUntouched(
      () => scenario.submit(Bet, "bet", { playerId: "player-2" }),
      Code.WalletPlayerMismatch,
    );
  });

  test("currency different from the wallet → CURRENCY_MISMATCH", () => {
    start();
    expectUntouched(
      () => scenario.submit(Bet, "bet", { money: usd("10.00") }),
      Code.CurrencyMismatch,
    );
    expectUntouched(
      () => scenario.submit(Win, "win", { money: usd("10.00") }),
      Code.CurrencyMismatch,
    );
  });

  test("player is checked before currency (fixed order)", () => {
    start();
    expectRejected(
      scenario.submit(Bet, "bet", { playerId: "player-2", money: usd("10.00") }),
      Code.WalletPlayerMismatch,
    );
  });
});

describe("PENDING_REFERENCE (references out of order)", () => {
  test("REFUND before its BET waits, then is applied once the BET arrives", () => {
    start();
    const refund = scenario.submit(Refund, "refund", { reference: "bet" });
    expect(refund.outcome).toEqual({ status: Status.PendingReference });
    expect(refund.transaction.status).toBe(Status.PendingReference);
    expect(refund.transaction.observedBalance?.amount).toBe("100.00");
    expect(refund.transaction.nextReferenceCheckAt?.getTime()).toBe(scenario.now.getTime() + 750);
    expect(scenario.ledger).toHaveLength(1);

    scenario.submit(Bet, "bet");
    const outcome = scenario.recheck(refund.transaction, addMillisecondsTo(scenario.now, 1_000));
    expect(outcome.status).toBe(Status.Processed);
    expect(refund.transaction.observedBalance?.amount).toBe("100.00");
    expect(scenario.wallet.balance.amount).toBe("100.00");
  });

  test("ROLLBACK before its BET waits too", () => {
    start();
    expect(scenario.submit(Rollback, "rollback", { reference: "bet" }).outcome.status).toBe(
      Status.PendingReference,
    );
  });

  test("WIN with a missing reference waits (decision 3)", () => {
    start();
    expect(scenario.submit(Win, "win", { reference: "bet" }).outcome.status).toBe(
      Status.PendingReference,
    );
    expect(scenario.wallet.balance.amount).toBe("100.00");
  });

  test("still missing: reschedules with exponential backoff", () => {
    start();
    const refund = scenario.submit(Refund, "refund", { reference: "bet" });
    const firstCheck = scenario.now;
    scenario.recheck(refund.transaction, addMillisecondsTo(firstCheck, 1_000));
    expect(refund.transaction.referenceAttempts).toBe(1);
    // attempt 1 with random 0.5: 2000 ms ceiling → 1500 ms.
    expect(refund.transaction.nextReferenceCheckAt?.getTime()).toBe(scenario.now.getTime() + 1_500);
    scenario.recheck(refund.transaction, addMillisecondsTo(firstCheck, 3_000));
    expect(refund.transaction.referenceAttempts).toBe(2);
    expect(refund.transaction.status).toBe(Status.PendingReference);
  });

  test("expired → REFERENCE_NOT_FOUND", () => {
    start();
    const refund = scenario.submit(Refund, "refund", { reference: "bet" });
    const expiresAt = refund.transaction.referenceExpiresAt;
    if (expiresAt === undefined) {
      throw new Error("expected an expiry");
    }
    const outcome = scenario.recheck(refund.transaction, expiresAt);
    expect(outcome).toEqual({ status: Status.Rejected, failureCode: Code.ReferenceNotFound });
    expect(refund.transaction.failureCode).toBe(Code.ReferenceNotFound);
  });

  test("the reference arriving right at expiry still wins over the expiry", () => {
    start();
    const refund = scenario.submit(Refund, "refund", { reference: "bet" });
    scenario.submit(Bet, "bet");
    const expiresAt = refund.transaction.referenceExpiresAt;
    if (expiresAt === undefined) {
      throw new Error("expected an expiry");
    }
    expect(scenario.recheck(refund.transaction, expiresAt).status).toBe(Status.Processed);
  });

  test("reference that is itself PENDING_REFERENCE → the dependent waits", () => {
    start();
    scenario.submit(Refund, "refund", { reference: "bet" });
    const rollback = scenario.submit(Rollback, "rollback", { reference: "refund" });
    expect(rollback.outcome.status).toBe(Status.PendingReference);
  });

  test("reference still pending at expiry → REFERENCE_NOT_PROCESSED", () => {
    start();
    scenario.submit(Refund, "refund", { reference: "bet" });
    const rollback = scenario.submit(Rollback, "rollback", { reference: "refund" });
    const expiresAt = rollback.transaction.referenceExpiresAt;
    if (expiresAt === undefined) {
      throw new Error("expected an expiry");
    }
    expect(scenario.recheck(rollback.transaction, expiresAt)).toEqual({
      status: Status.Rejected,
      failureCode: Code.ReferenceNotProcessed,
    });
  });

  test("reference REJECTED → REFERENCE_NOT_PROCESSED", () => {
    start("10.00");
    scenario.submit(Bet, "bet", { money: brl("50.00") });
    expectUntouched(
      () => scenario.submit(Refund, "refund", { money: brl("50.00"), reference: "bet" }),
      Code.ReferenceNotProcessed,
    );
  });

  test("reference FAILED → REFERENCE_NOT_PROCESSED", () => {
    start();
    const failed = wager(Bet, { externalTransactionId: "bet" });
    failed.fail({ code: Code.InternalPermanentError, at: scenario.now });
    scenario.transactions.push(failed);
    expectUntouched(
      () => scenario.submit(Refund, "refund", { reference: "bet" }),
      Code.ReferenceNotProcessed,
    );
  });
});

describe("settleWager guards (programming errors)", () => {
  const input = (overrides: Partial<Parameters<typeof settleWager>[0]> = {}) => ({
    transaction: wager(Bet),
    wallet: newWallet(),
    reference: undefined,
    ledgerEntryId: "entry-x",
    at: scenario.now,
    referenceRetry: RETRY,
    ...overrides,
  });

  test("a terminal transaction cannot be settled again", () => {
    start();
    const { transaction } = scenario.submit(Bet, "bet");
    expect(() => settleWager(input({ transaction, wallet: scenario.wallet }))).toThrow(
      InvalidOperationError,
    );
  });

  test("the wallet must be the transaction's wallet", () => {
    start();
    expect(() => settleWager(input({ wallet: newWallet({ id: "wallet-2" }) }))).toThrow(
      InvalidOperationError,
    );
  });

  test("the reference state must be given exactly when a reference was informed", () => {
    start();
    expect(() => settleWager(input({ reference: ReferenceState.notFound() }))).toThrow(
      InvalidOperationError,
    );
    expect(() =>
      settleWager(
        input({ transaction: wager(Refund, { reference: "bet" }), reference: undefined }),
      ),
    ).toThrow(InvalidOperationError);
  });
});
