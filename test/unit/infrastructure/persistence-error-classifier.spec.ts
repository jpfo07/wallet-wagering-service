import { describe, expect, test } from "bun:test";
import { ConnectionException, DeadlockException, DriverException } from "@mikro-orm/core";
import { UniqueTarget } from "../../../src/application/errors.ts";
import { classifyPersistenceError } from "../../../src/infrastructure/persistence/persistence-error-classifier.ts";

/** What the pg driver hands to MikroORM: an Error with `code` (SQLSTATE) and `constraint`. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code, constraint });
}

describe("classifyPersistenceError (by SQLSTATE, never by class or message)", () => {
  test.each([
    ["55P03", "lock_timeout"],
    ["40P01", "deadlock"],
    ["40001", "serialization failure"],
    ["08000", "connection exception"],
    ["08006", "connection failure"],
    ["08003", "connection does not exist"],
    ["57P01", "admin shutdown"],
    ["57P03", "cannot connect now"],
    ["53300", "too many connections"],
  ])("%s (%s) is transient", (code) => {
    expect(classifyPersistenceError(new DriverException(pgError(code)))).toEqual({
      kind: "transient",
      reason: code,
    });
  });

  test("55P03 arrives as a generic DriverException and is still transient", () => {
    const error = new DriverException(pgError("55P03"));
    expect(error).not.toBeInstanceOf(DeadlockException);
    expect(classifyPersistenceError(error).kind).toBe("transient");
  });

  test.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"])(
    "network error %s (no SQLSTATE) is transient",
    (code) => {
      expect(classifyPersistenceError(Object.assign(new Error(code), { code }))).toEqual({
        kind: "transient",
        reason: code,
      });
    },
  );

  test("a ConnectionException without a code is transient", () => {
    expect(classifyPersistenceError(new ConnectionException(new Error("gone"))).kind).toBe(
      "transient",
    );
  });

  test.each([
    ["wager_transactions_provider_idempotency_key_uq", UniqueTarget.IdempotencyKey],
    ["wager_transactions_provider_external_uq", UniqueTarget.ExternalTransactionId],
  ])("23505 on %s is a concurrent insert (restart, not a bug)", (constraint, target) => {
    expect(classifyPersistenceError(new DriverException(pgError("23505", constraint)))).toEqual({
      kind: "concurrent-insert",
      target,
    });
  });

  test.each([
    ["23505", "wallet_ledger_entries_transaction_uq"],
    ["23505", "wager_transactions_single_reversal_uq"],
    ["23514", "wallets_matches_ledger"],
    ["23514", "wallets_balance_non_negative_chk"],
    ["23503", "wallet_ledger_entries_transaction_fk"],
  ])("%s on %s is an integrity error (bug, never retried)", (code, constraint) => {
    expect(classifyPersistenceError(new DriverException(pgError(code, constraint)))).toEqual({
      kind: "integrity",
      sqlState: code,
      constraint,
    });
  });

  test.each([
    ["57014", "statement timeout (a slow statement would be slow again)"],
    ["42P01", "undefined table"],
    ["22P02", "invalid text representation"],
  ])("%s (%s) is neither transient nor integrity", (code) => {
    expect(classifyPersistenceError(new DriverException(pgError(code)))).toEqual({
      kind: "other",
    });
  });

  test("non-errors and errors without a code are 'other'", () => {
    expect(classifyPersistenceError("boom")).toEqual({ kind: "other" });
    expect(classifyPersistenceError(new Error("no code"))).toEqual({ kind: "other" });
  });
});
