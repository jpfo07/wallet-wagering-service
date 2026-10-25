import { describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  PersistenceIntegrityError,
  StaleWalletVersionError,
  TransactionNotFoundError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../../../src/application/errors.ts";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";
import {
  CodeCategory,
  ErrorCode,
  FailureCode,
} from "../../../../src/domain/shared/failure-code.ts";
import { InvalidMoneyError } from "../../../../src/domain/shared/money.errors.ts";
import { WagerTransactionStatus } from "../../../../src/domain/wager/wager-transaction-status.ts";
import { InvalidWagerTransactionError } from "../../../../src/domain/wager/wager-transaction.errors.ts";
import {
  HttpErrorCode,
  InvalidRequestError,
  mapError,
} from "../../../../src/infrastructure/http/http-errors.ts";
import {
  httpStatusForResult,
  statusForCategory,
} from "../../../../src/infrastructure/http/http-status.ts";

describe("HTTP status by category (the one table every endpoint follows)", () => {
  test.each([
    [CodeCategory.InvalidPayload, 400],
    [CodeCategory.NotFound, 404],
    [CodeCategory.Conflict, 409],
    [CodeCategory.BusinessRejection, 422],
    [CodeCategory.PermanentFailure, 422],
    [CodeCategory.Transient, 503],
  ])("%s → %d", (category, status) => {
    expect(statusForCategory(category)).toBe(status);
  });
});

describe("httpStatusForResult", () => {
  const base = { transactionId: "t", idempotentReplay: false };
  test.each([
    [{ ...base, status: WagerTransactionStatus.Processed }, 200],
    [{ ...base, status: WagerTransactionStatus.PendingReference }, 202],
    [
      {
        ...base,
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InsufficientFunds,
      },
      422,
    ],
    [
      {
        ...base,
        status: WagerTransactionStatus.Failed,
        failureCode: FailureCode.InternalPermanentError,
      },
      422,
    ],
  ])("%o → %d (same for a replay)", (result, status) => {
    expect(httpStatusForResult(result)).toBe(status);
    expect(httpStatusForResult({ ...result, idempotentReplay: true })).toBe(status);
  });
});

describe("mapError", () => {
  test.each([
    [new InvalidCommandError("bad"), 400, ErrorCode.InvalidPayload],
    [new InvalidMoneyError(ErrorCode.InvalidAmount, "bad amount"), 400, ErrorCode.InvalidAmount],
    [
      new InvalidWagerTransactionError(ErrorCode.KindNotAllowed, "OPENING is internal"),
      400,
      ErrorCode.KindNotAllowed,
    ],
    [new WalletNotFoundError("w"), 404, ErrorCode.WalletNotFound],
    [new TransactionNotFoundError("t"), 404, ErrorCode.TransactionNotFound],
    [new WalletAlreadyExistsError("p", "BRL"), 409, ErrorCode.WalletAlreadyExists],
  ])("%p → %d %s", (error, status, code) => {
    const mapped = mapError(error);
    expect(mapped).toEqual({
      status,
      body: { error: code, message: error.message },
      retryable: false,
      log: "none",
    });
  });

  test("idempotency conflict carries the existing transactionId", () => {
    expect(
      mapError(new IdempotencyConflictError(ErrorCode.IdempotencyKeyReused, "tx-1")).body,
    ).toMatchObject({ error: ErrorCode.IdempotencyKeyReused, transactionId: "tx-1" });
  });

  test("transient → 503, retryable, generic message (no SQLSTATE leaks)", () => {
    const mapped = mapError(new TransientFailureError(3, new Error("55P03 lock timeout")));
    expect(mapped).toEqual({
      status: 503,
      body: { error: ErrorCode.TransientFailure, message: "temporarily unavailable, retry later" },
      retryable: true,
      log: "warn",
    });
  });

  test("shape errors keep their details", () => {
    const details = [{ path: "body.playerId", message: "must be a UUID" }];
    expect(mapError(new InvalidRequestError("invalid body", details)).body).toEqual({
      error: ErrorCode.InvalidPayload,
      message: "invalid body",
      details,
    });
  });

  test("framework 4xx: unknown route → 404 ROUTE_NOT_FOUND; anything else → 400", () => {
    expect(mapError(new Error("x"), { status: 404, message: "Cannot GET /x" })).toMatchObject({
      status: 404,
      body: { error: "ROUTE_NOT_FOUND" },
    });
    expect(mapError(new Error("x"), { status: 413, message: "too large" })).toMatchObject({
      status: 400,
      body: { error: ErrorCode.InvalidPayload, message: "too large" },
    });
  });

  test.each([
    [
      "integrity error (bug)",
      new PersistenceIntegrityError("23514", "wallets_matches_ledger", null),
    ],
    ["stale wallet version (bug)", new StaleWalletVersionError("w", 3)],
    ["domain invariant (bug)", new InvalidOperationError("x")],
    ["anything else", new TypeError("boom")],
    ["a non-error value", "boom"],
  ])("%s → 500 INTERNAL_ERROR with a generic message, logged", (_label, error) => {
    expect(mapError(error)).toEqual({
      status: 500,
      body: { error: HttpErrorCode.InternalError, message: "internal error" },
      retryable: false,
      log: "error",
    });
  });
});
