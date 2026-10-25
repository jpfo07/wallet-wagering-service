import { describe, expect, test } from "bun:test";
import { checkIdempotency } from "../../../../src/domain/idempotency/idempotency-check.ts";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";
import { ErrorCode } from "../../../../src/domain/shared/failure-code.ts";
import { WagerTransactionKind } from "../../../../src/domain/wager/wager-transaction-kind.ts";
import { PROVIDER, brl, wager } from "../../../support/domain-builders.ts";

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
        incoming: {
          providerId: PROVIDER,
          idempotencyKey: "provider-a:tx-1",
          payloadHash: samePayload.payloadHash,
        },
      }),
    ).toEqual({ type: "NEW" });
  });

  test("same key, same payload → REPLAY of the stored transaction", () => {
    const decision = checkIdempotency({
      byKey: stored,
      byExternalId: stored,
      incoming: {
        providerId: PROVIDER,
        idempotencyKey: stored.idempotencyKey,
        payloadHash: samePayload.payloadHash,
      },
    });
    expect(decision).toEqual({ type: "REPLAY", transaction: stored });
  });

  test("same key, divergent payload → IDEMPOTENCY_KEY_REUSED, never a replay", () => {
    expect(stored.matchesPayload(divergentPayload.payloadHash)).toBe(false);
    const decision = checkIdempotency({
      byKey: stored,
      byExternalId: stored,
      incoming: {
        providerId: PROVIDER,
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
      incoming: {
        providerId: PROVIDER,
        idempotencyKey: "another-key",
        payloadHash: samePayload.payloadHash,
      },
    });
    expect(decision).toEqual({
      type: "CONFLICT",
      code: ErrorCode.ExternalTransactionIdConflict,
      transaction: stored,
    });
  });

  test("the same key under another provider is a different key → NEW, never a replay or conflict", () => {
    // The lookup is by (providerId, idempotencyKey): provider-b finds nothing under provider-a's key.
    const decision = checkIdempotency({
      byKey: undefined,
      byExternalId: undefined,
      incoming: {
        providerId: "provider-b",
        idempotencyKey: stored.idempotencyKey,
        payloadHash: stored.payloadHash,
      },
    });
    expect(decision).toEqual({ type: "NEW" });
  });

  test.each([
    ["another key", { providerId: PROVIDER, idempotencyKey: "other" }],
    ["another provider", { providerId: "provider-b", idempotencyKey: "provider-a:tx-1" }],
  ])("byKey must carry the incoming provider and key (%s)", (_label, incoming) => {
    expect(() =>
      checkIdempotency({
        byKey: stored,
        byExternalId: undefined,
        incoming: { ...incoming, payloadHash: stored.payloadHash },
      }),
    ).toThrow(InvalidOperationError);
  });

  test("byExternalId must belong to the incoming provider", () => {
    expect(() =>
      checkIdempotency({
        byKey: undefined,
        byExternalId: stored,
        incoming: {
          providerId: "provider-b",
          idempotencyKey: "k",
          payloadHash: stored.payloadHash,
        },
      }),
    ).toThrow(InvalidOperationError);
  });
});
