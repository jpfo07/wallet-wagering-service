import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../../../src/domain/events/wallet-balance-changed.ts";
import {
  InvalidOutboxStateError,
  OutboxMessage,
} from "../../../../src/domain/messaging/outbox-message.ts";
import { ExponentialBackoff } from "../../../../src/domain/shared/backoff-policy.ts";
import { T0, at, brl, newWallet } from "../../../support/domain-builders.ts";

const backoff = ExponentialBackoff.of({ baseMs: 1_000, maxMs: 8_000 });
const noJitter = () => 0.999_999;

function enqueued(): OutboxMessage {
  const wallet = newWallet();
  const entry = wallet.debit({
    transactionId: "tx-1",
    money: brl("10.00"),
    ledgerEntryId: "entry-1",
    at: T0,
  });
  return OutboxMessage.enqueue(
    WalletBalanceChanged.from(wallet, entry, {
      eventId: "event-1",
      correlationId: "corr-1",
      occurredAt: T0,
    }),
  );
}

describe("OutboxMessage.enqueue", () => {
  test("takes id, aggregate, type and payload from the event and is due right away", () => {
    const message = enqueued();
    expect(message.id).toBe("event-1");
    expect(message.aggregateId).toBe("wallet-1");
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.payload["eventId"]).toBe("event-1");
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
    expect(Object.isFrozen(message.payload)).toBe(true);
  });

  test("the payload is the event envelope, JSON-stable", () => {
    const message = enqueued();
    expect(JSON.parse(JSON.stringify(message.payload))).toEqual(message.payload);
  });
});

describe("OutboxMessage retry and publication", () => {
  test("scheduleRetry backs off exponentially up to the ceiling", () => {
    const message = enqueued();
    const delays: number[] = [];
    let now = T0;
    for (let i = 0; i < 6; i += 1) {
      message.scheduleRetry(now, backoff, noJitter);
      const next = message.nextAttemptAt;
      if (next === undefined) {
        throw new Error("expected a next attempt");
      }
      delays.push(next.getTime() - now.getTime());
      expect(message.isDue(now)).toBe(false);
      expect(message.isDue(next)).toBe(true);
      now = next;
    }
    expect(message.attempts).toBe(6);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  test("jitter keeps at least half of the delay", () => {
    const message = enqueued();
    message.scheduleRetry(T0, backoff, () => 0);
    expect(message.nextAttemptAt).toEqual(at(500));
  });

  test("never gives up: there is no attempt limit", () => {
    const message = enqueued();
    for (let i = 0; i < 100; i += 1) {
      message.scheduleRetry(T0, backoff, noJitter);
    }
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(100);
  });

  test("markPublished ends it; a published message cannot be retried or republished", () => {
    const message = enqueued();
    message.markPublished(at(10));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(10_000))).toBe(false);
    expect(message.publishedAt).toEqual(at(10));
    expect(() => {
      message.scheduleRetry(at(20), backoff, noJitter);
    }).toThrow(InvalidOutboxStateError);
    expect(() => {
      message.markPublished(at(30));
    }).toThrow(InvalidOutboxStateError);
  });

  test("rehydrate keeps the persisted schedule", () => {
    const message = OutboxMessage.rehydrate({
      id: "e",
      aggregateId: "w",
      eventType: "WalletBalanceChanged",
      payload: {},
      occurredAt: T0,
      attempts: 3,
      nextAttemptAt: at(5_000),
    });
    expect(message.attempts).toBe(3);
    expect(message.isDue(at(4_999))).toBe(false);
    expect(message.isDue(at(5_000))).toBe(true);
  });
});
