import { describe, expect, test } from "bun:test";
import { checkIdempotency } from "../../../../src/domain/idempotency/idempotency-check.ts";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";
import { ErrorCode } from "../../../../src/domain/shared/failure-code.ts";
import { WagerTransactionKind } from "../../../../src/domain/wager/wager-transaction-kind.ts";
import { brl, wager } from "../../../support/domain-builders.ts";

const stored = wager(WagerTransactionKind.Bet, {
  externalTransactionId: "tx-1",
  money: brl("25.00"),
});
const samePayload = wager(WagerTransactionKind.Bet, {
  externalTransactionId: "tx-1",
  money: brl("25.00"),
});
const divergentPayload = wager(WagerTransactionKind.Bet, {
  externalTransactionId: "tx-1",
  money: brl("26.00"),
});

describe("checkIdempotency", () => {
  test("nothing stored → NEW", () => {
    expect(
      checkIdempotency({
        byKey: undefined,
        byExternalId: undefined,
        incoming: { idempotencyKey: "provider-a:tx-1", payloadHash: samePayload.payloadHash },
      }),
    ).toEqual({ type: "NEW" });
  });

  test("same key, same payload → REPLAY of the stored transaction", () => {
    const decision = checkIdempotency({
      byKey: stored,
      byExternalId: stored,
      incoming: { idempotencyKey: stored.idempotencyKey, payloadHash: samePayload.payloadHash },
    });
    expect(decision).toEqual({ type: "REPLAY", transaction: stored });
  });

  test("same key, divergent payload → IDEMPOTENCY_KEY_REUSED, never a replay", () => {
    expect(stored.matchesPayload(divergentPayload.payloadHash)).toBe(false);
    const decision = checkIdempotency({
      byKey: stored,
      byExternalId: stored,
      incoming: {
        idempotencyKey: stored.idempotencyKey,
        payloadHash: divergentPayload.payloadHash,
      },
    });
    expect(decision).toEqual({
      type: "CONFLICT",
      code: ErrorCode.IdempotencyKeyReused,
      transaction: stored,
    });
  });

  test("new key for an existing (providerId, externalTransactionId) → conflict, even with the same payload", () => {
    const decision = checkIdempotency({
      byKey: undefined,
      byExternalId: stored,
      incoming: { idempotencyKey: "another-key", payloadHash: samePayload.payloadHash },
    });
    expect(decision).toEqual({
      type: "CONFLICT",
      code: ErrorCode.ExternalTransactionIdConflict,
      transaction: stored,
    });
  });

  test("byKey must actually carry the incoming key", () => {
    expect(() =>
      checkIdempotency({
        byKey: stored,
        byExternalId: undefined,
        incoming: { idempotencyKey: "other", payloadHash: stored.payloadHash },
      }),
    ).toThrow(InvalidOperationError);
  });
});
