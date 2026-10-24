import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  computeWagerPayloadHash,
  PAYLOAD_HASH_PATTERN,
} from "../../../../src/domain/idempotency/payload-hash.ts";
import type { WagerPayloadFields } from "../../../../src/domain/idempotency/payload-hash.ts";
import { WagerTransactionKind } from "../../../../src/domain/wager/wager-transaction-kind.ts";
import { brl, usd } from "../../../support/domain-builders.ts";

const base: WagerPayloadFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: WagerTransactionKind.Bet,
  money: brl("25.00"),
};

const CANONICAL =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
  '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
  '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

describe("computeWagerPayloadHash", () => {
  test("golden value: SHA-256 hex of the documented canonical JSON", () => {
    const expected = createHash("sha256").update(CANONICAL, "utf8").digest("hex");
    expect(computeWagerPayloadHash(base)).toBe(expected);
    // Pinned literal: changing the algorithm by accident would turn every replay into a conflict.
    expect(computeWagerPayloadHash(base)).toBe(
      "629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344",
    );
  });

  test("is a lowercase 64-char hex", () => {
    expect(computeWagerPayloadHash(base)).toMatch(PAYLOAD_HASH_PATTERN);
  });

  test.each([
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: "player-x" }],
    ["walletId", { walletId: "wallet-x" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "other-game" }],
    ["kind", { kind: WagerTransactionKind.Win }],
    ["amount", { money: brl("25.01") }],
    ["currency", { money: usd("25.00") }],
    ["reference (added)", { referenceExternalTransactionId: "transaction-100" }],
  ])("changes when %s changes (same key + this payload = conflict)", (_field, change) => {
    expect(computeWagerPayloadHash({ ...base, ...change })).not.toBe(computeWagerPayloadHash(base));
  });

  test("two different references hash differently", () => {
    expect(computeWagerPayloadHash({ ...base, referenceExternalTransactionId: "a" })).not.toBe(
      computeWagerPayloadHash({ ...base, referenceExternalTransactionId: "b" }),
    );
  });

  test("an absent reference is the same as no reference field at all", () => {
    expect(computeWagerPayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(
      computeWagerPayloadHash(base),
    );
  });

  test("ignores the idempotency key and transport metadata (HTTP and SQS hash the same)", () => {
    const sqsData = {
      ...base,
      idempotencyKey: "provider-a:transaction-123",
      messageId: "msg-123",
      occurredAt: "2026-07-29T15:00:00.000Z",
      correlationId: "corr-1",
    };
    expect(computeWagerPayloadHash(sqsData)).toBe(computeWagerPayloadHash(base));
  });
});
