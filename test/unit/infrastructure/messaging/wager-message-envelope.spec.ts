import { describe, expect, test } from "bun:test";
import { parseWagerMessage } from "../../../../src/infrastructure/messaging/wager-message-envelope.ts";

const envelope = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  messageId: "msg-123",
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...data,
  },
  ...overrides,
});

describe("parseWagerMessage", () => {
  test("the message of the challenge is valid", () => {
    const parsed = parseWagerMessage(JSON.stringify(envelope()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope.messageId).toBe("msg-123");
      expect(parsed.envelope.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    }
  });

  test("an optional reference is accepted", () => {
    const body = JSON.stringify(
      envelope({}, { kind: "REFUND", referenceExternalTransactionId: "bet-1" }),
    );
    expect(parseWagerMessage(body).ok).toBe(true);
  });

  test("an offset in occurredAt is accepted", () => {
    const body = JSON.stringify(envelope({ occurredAt: "2026-07-29T12:00:00.000-03:00" }));
    expect(parseWagerMessage(body).ok).toBe(true);
  });

  test.each([
    ["undefined body", undefined],
    ["not JSON", "{not json"],
    ["JSON that is not an object", "42"],
    ["wrong type", JSON.stringify(envelope({ type: "WagerTransactionCancelled" }))],
    ["missing messageId", JSON.stringify(envelope({ messageId: undefined }))],
    ["blank messageId", JSON.stringify(envelope({ messageId: "  " }))],
    ["occurredAt not ISO", JSON.stringify(envelope({ occurredAt: "yesterday" }))],
    ["unknown envelope field", JSON.stringify(envelope({ extra: 1 }))],
    ["unknown data field", JSON.stringify(envelope({}, { referenceExternalTransactionID: "x" }))],
    ["missing idempotencyKey", JSON.stringify(envelope({}, { idempotencyKey: undefined }))],
    ["walletId not a UUID", JSON.stringify(envelope({}, { walletId: "w-1" }))],
    [
      "amount as a number",
      JSON.stringify(envelope({}, { money: { amount: 25, currency: "BRL" } })),
    ],
  ])("%s → malformed", (_, body) => {
    const parsed = parseWagerMessage(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
  });

  test("semantic rules are not repeated here: a bad amount format reaches the domain", () => {
    // "25" passes the shape; Money rejects it with INVALID_AMOUNT (→ DLQ with that code).
    const body = JSON.stringify(envelope({}, { money: { amount: "25", currency: "BRL" } }));
    expect(parseWagerMessage(body).ok).toBe(true);
  });
});
