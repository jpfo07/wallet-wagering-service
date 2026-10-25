import { describe, expect, test } from "bun:test";
import {
  ConcurrentInsertConflictError,
  IdempotencyConflictError,
  InvalidCommandError,
  PersistenceIntegrityError,
  PoisonMessageError,
  StaleWalletVersionError,
  TransientFailureError,
  TransientPersistenceError,
  UniqueTarget,
  WalletNotFoundError,
} from "../../../../src/application/errors.ts";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";
import { ErrorCode, FailureCode } from "../../../../src/domain/shared/failure-code.ts";
import { InvalidMoneyError } from "../../../../src/domain/shared/money.errors.ts";
import { WagerTransactionStatus } from "../../../../src/domain/wager/wager-transaction-status.ts";
import { InvalidWagerTransactionError } from "../../../../src/domain/wager/wager-transaction.errors.ts";
import {
  ConsumerFailureCode,
  decideForError,
  decideForResult,
  isConnectionFailure,
} from "../../../../src/infrastructure/messaging/delivery-decision.ts";

const transient = (reason: string) =>
  new TransientFailureError(3, new TransientPersistenceError(reason, new Error(reason)));

describe("decideForResult: every persisted outcome is final → ack", () => {
  const base = { transactionId: "t", idempotentReplay: false };
  test.each([
    [{ ...base, status: WagerTransactionStatus.Processed }, "PROCESSED"],
    [{ ...base, status: WagerTransactionStatus.PendingReference }, "PENDING_REFERENCE"],
    [
      {
        ...base,
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InsufficientFunds,
      },
      "INSUFFICIENT_FUNDS",
    ],
    [
      {
        ...base,
        status: WagerTransactionStatus.Failed,
        failureCode: FailureCode.InternalPermanentError,
        idempotentReplay: true,
      },
      "INTERNAL_PERMANENT_ERROR",
    ],
  ])("%o → ack %s", (result, outcome) => {
    expect(decideForResult(result)).toEqual({ action: "ack", outcome, log: "info" });
  });
});

describe("decideForError", () => {
  test.each([
    [new WalletNotFoundError("w"), ErrorCode.WalletNotFound],
    [
      new IdempotencyConflictError(ErrorCode.IdempotencyKeyReused, "t"),
      ErrorCode.IdempotencyKeyReused,
    ],
    [
      new IdempotencyConflictError(ErrorCode.ExternalTransactionIdConflict, "t"),
      ErrorCode.ExternalTransactionIdConflict,
    ],
  ])("terminal answer %p → ack (a redelivery would repeat it)", (error, outcome) => {
    expect(decideForError(error)).toEqual({ action: "ack", outcome, log: "warn" });
  });

  test.each([
    [new InvalidCommandError("bad"), ErrorCode.InvalidPayload],
    [new InvalidMoneyError(ErrorCode.InvalidAmount, "bad amount"), ErrorCode.InvalidAmount],
    [
      new InvalidWagerTransactionError(ErrorCode.KindNotAllowed, "OPENING is internal"),
      ErrorCode.KindNotAllowed,
    ],
    [new PoisonMessageError("c", "m"), ConsumerFailureCode.PoisonMessage],
  ])("never processable %p → DLQ at once", (error, failureCode) => {
    expect(decideForError(error)).toMatchObject({ action: "dlq", failureCode });
  });

  test("lock timeout → retry, database still reachable", () => {
    expect(decideForError(transient("55P03"))).toEqual({
      action: "retry",
      reason: "55P03",
      databaseUnavailable: false,
      log: "warn",
    });
  });

  test.each(["ECONNREFUSED", "08006", "57P01", "57P03", "connection"])(
    "connection failure %s → retry and pause fetching",
    (reason) => {
      expect(decideForError(transient(reason))).toMatchObject({
        action: "retry",
        databaseUnavailable: true,
      });
    },
  );

  test.each([
    ["integrity (bug)", new PersistenceIntegrityError("23514", "c", null)],
    ["stale wallet version (bug)", new StaleWalletVersionError("w", 3)],
    ["domain invariant (bug)", new InvalidOperationError("x")],
    [
      "second concurrent insert",
      new ConcurrentInsertConflictError(UniqueTarget.IdempotencyKey, null),
    ],
    ["anything else", new TypeError("boom")],
  ])("%s → retry, dead-lettered by the redrive policy", (_, error) => {
    expect(decideForError(error)).toMatchObject({
      action: "retry",
      databaseUnavailable: false,
      log: "error",
    });
  });
});

describe("isConnectionFailure", () => {
  test.each([
    ["08001", true],
    ["57P01", true],
    ["ECONNRESET", true],
    ["55P03", false],
    ["40P01", false],
    ["53300", false],
  ])("%s → %p", (reason, expected) => {
    expect(isConnectionFailure(reason)).toBe(expected);
  });
});
