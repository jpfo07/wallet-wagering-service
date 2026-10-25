import { describe, expect, test } from "bun:test";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";
import { FailureCode } from "../../../../src/domain/shared/failure-code.ts";
import { WagerTransactionKind as Kind } from "../../../../src/domain/wager/wager-transaction-kind.ts";
import { WagerTransactionStatus as Status } from "../../../../src/domain/wager/wager-transaction-status.ts";
import type { WagerTransaction } from "../../../../src/domain/wager/wager-transaction.ts";
import { InvalidTransactionStateError } from "../../../../src/domain/wager/wager-transaction.errors.ts";
import { at, brl, wager } from "../../../support/domain-builders.ts";

const balance = brl("90.00");

type Transition = (tx: WagerTransaction) => void;

const transitions: Record<string, Transition> = {
  markProcessed: (tx) => {
    tx.markProcessed({ referenceTransactionId: "tx-bet", observedBalance: balance, at: at(9_000) });
  },
  reject: (tx) => {
    tx.reject({ code: FailureCode.AmountMismatch, observedBalance: balance, at: at(9_000) });
  },
  markPendingReference: (tx) => {
    tx.markPendingReference({
      observedBalance: balance,
      nextCheckAt: at(10_000),
      expiresAt: at(60_000),
      at: at(9_000),
    });
  },
  scheduleNextReferenceCheck: (tx) => {
    tx.scheduleNextReferenceCheck({ nextCheckAt: at(20_000), at: at(9_000) });
  },
  fail: (tx) => {
    tx.fail({ code: FailureCode.InternalPermanentError, at: at(9_000) });
  },
};

function refund(): WagerTransaction {
  return wager(Kind.Refund, { reference: "ext-bet" });
}

function inStatus(status: Status): WagerTransaction {
  const tx = refund();
  if (status === Status.Pending) {
    return tx;
  }
  if (status === Status.PendingReference) {
    transitions["markPendingReference"]?.(tx);
    return tx;
  }
  const into = {
    [Status.Processed]: "markProcessed",
    [Status.Rejected]: "reject",
    [Status.Failed]: "fail",
  }[status];
  transitions[into]?.(tx);
  return tx;
}

const expected: Record<Status, Record<string, Status | "throws">> = {
  [Status.Pending]: {
    markProcessed: Status.Processed,
    reject: Status.Rejected,
    markPendingReference: Status.PendingReference,
    scheduleNextReferenceCheck: "throws",
    fail: Status.Failed,
  },
  [Status.PendingReference]: {
    markProcessed: Status.Processed,
    reject: Status.Rejected,
    markPendingReference: "throws",
    scheduleNextReferenceCheck: Status.PendingReference,
    fail: Status.Failed,
  },
  [Status.Processed]: {},
  [Status.Rejected]: {},
  [Status.Failed]: {},
};

describe("WagerTransaction transition table", () => {
  for (const from of Object.values(Status)) {
    for (const [name, apply] of Object.entries(transitions)) {
      const outcome = expected[from][name] ?? "throws";
      test(`${from} --${name}--> ${outcome}`, () => {
        const tx = inStatus(from);
        expect(tx.status).toBe(from);
        if (outcome === "throws") {
          expect(() => {
            apply(tx);
          }).toThrow(InvalidTransactionStateError);
          expect(tx.status).toBe(from);
        } else {
          apply(tx);
          expect(tx.status).toBe(outcome);
        }
      });
    }
  }

  test("terminal statuses report isTerminal", () => {
    expect(inStatus(Status.Pending).isTerminal()).toBe(false);
    expect(inStatus(Status.PendingReference).isTerminal()).toBe(false);
    expect(inStatus(Status.Processed).isTerminal()).toBe(true);
    expect(inStatus(Status.Rejected).isTerminal()).toBe(true);
    expect(inStatus(Status.Failed).isTerminal()).toBe(true);
  });
});

describe("WagerTransaction transition details", () => {
  test("markProcessed records reference, observed balance and processedAt", () => {
    const tx = inStatus(Status.Processed);
    expect(tx.referenceTransactionId).toBe("tx-bet");
    expect(tx.observedBalance?.amount).toBe("90.00");
    expect(tx.processedAt).toEqual(at(9_000));
    expect(tx.updatedAt).toEqual(at(9_000));
  });

  test("markProcessed requires referenceTransactionId exactly when a reference was informed", () => {
    expect(() => {
      refund().markProcessed({
        referenceTransactionId: undefined,
        observedBalance: balance,
        at: at(1),
      });
    }).toThrow(InvalidOperationError);
    expect(() => {
      wager(Kind.Bet).markProcessed({
        referenceTransactionId: "x",
        observedBalance: balance,
        at: at(1),
      });
    }).toThrow(InvalidOperationError);
  });

  test("reject records the failureCode and the observed balance", () => {
    const tx = inStatus(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.AmountMismatch);
    expect(tx.observedBalance?.amount).toBe("90.00");
    expect(tx.processedAt).toBeUndefined();
  });

  test("markPendingReference schedules the first check and the expiry", () => {
    const tx = inStatus(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceCheckAt).toEqual(at(10_000));
    expect(tx.referenceExpiresAt).toEqual(at(60_000));
    expect(tx.isReferenceExpired(at(59_999))).toBe(false);
    expect(tx.isReferenceExpired(at(60_000))).toBe(true);
    expect(tx.isReferenceCheckDue(at(9_999))).toBe(false);
    expect(tx.isReferenceCheckDue(at(10_000))).toBe(true);
  });

  test("isReferenceCheckDue is false outside PENDING_REFERENCE", () => {
    expect(inStatus(Status.Processed).isReferenceCheckDue(at(10_000_000))).toBe(false);
    expect(inStatus(Status.Rejected).isReferenceCheckDue(at(10_000_000))).toBe(false);
  });

  test("markPendingReference needs a reference to wait for", () => {
    expect(() => {
      transitions["markPendingReference"]?.(wager(Kind.Bet));
    }).toThrow(InvalidOperationError);
  });

  test("scheduleNextReferenceCheck counts attempts", () => {
    const tx = inStatus(Status.PendingReference);
    transitions["scheduleNextReferenceCheck"]?.(tx);
    transitions["scheduleNextReferenceCheck"]?.(tx);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceCheckAt).toEqual(at(20_000));
  });

  test("leaving PENDING_REFERENCE clears the next check", () => {
    const tx = inStatus(Status.PendingReference);
    transitions["markProcessed"]?.(tx);
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  test("fail records INTERNAL_PERMANENT_ERROR", () => {
    expect(inStatus(Status.Failed).failureCode).toBe(FailureCode.InternalPermanentError);
  });
});
