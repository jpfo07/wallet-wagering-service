import { ConnectionException } from "@mikro-orm/core";
import { UniqueTarget } from "../../application/errors.ts";

/**
 * Classifies driver errors by SQLSTATE (the `code` field), never by exception class or message:
 * on PostgreSQL MikroORM maps 40P01 to DeadlockException but delivers 55P03 as a generic
 * DriverException, so the class is not a reliable signal.
 */
export type PersistenceErrorClass =
  | { readonly kind: "transient"; readonly reason: string }
  | { readonly kind: "concurrent-insert"; readonly target: UniqueTarget }
  | {
      readonly kind: "integrity";
      readonly sqlState: string;
      readonly constraint: string | undefined;
    }
  | { readonly kind: "other" };

/** The attempt can be repeated: nothing of it was committed, and idempotency covers the rest. */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  "55P03", // lock_not_available (lock_timeout)
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "57P01", // admin_shutdown (restart / failover)
  "57P03", // cannot_connect_now (database starting up)
  "53300", // too_many_connections
]);

/** Network failures surface as Node error codes, without a SQLSTATE. */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "EAI_AGAIN",
]);

/** The only uniqueness violations that are an expected race rather than a bug. */
const CONCURRENT_INSERT_CONSTRAINTS: Readonly<Record<string, UniqueTarget>> = {
  wager_transactions_provider_idempotency_key_uq: UniqueTarget.IdempotencyKey,
  wager_transactions_provider_external_uq: UniqueTarget.ExternalTransactionId,
};

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

export function classifyPersistenceError(error: unknown): PersistenceErrorClass {
  const code = stringField(error, "code");
  // Checked first: "EPIPE" also has the shape of a SQLSTATE (no SQLSTATE class starts with "E").
  if (code !== undefined && TRANSIENT_NETWORK_CODES.has(code)) {
    return { kind: "transient", reason: code };
  }
  if (code !== undefined && SQLSTATE_PATTERN.test(code)) {
    if (TRANSIENT_SQLSTATES.has(code) || code.startsWith("08")) {
      return { kind: "transient", reason: code };
    }
    if (code.startsWith("23")) {
      const constraint = stringField(error, "constraint");
      const target =
        code === "23505" && constraint !== undefined
          ? CONCURRENT_INSERT_CONSTRAINTS[constraint]
          : undefined;
      return target === undefined
        ? { kind: "integrity", sqlState: code, constraint }
        : { kind: "concurrent-insert", target };
    }
    return { kind: "other" };
  }
  if (error instanceof ConnectionException) {
    return { kind: "transient", reason: "connection" };
  }
  return { kind: "other" };
}

function stringField(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value: unknown = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
