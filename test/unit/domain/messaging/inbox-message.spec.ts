import { describe, expect, test } from "bun:test";
import {
  InboxMessage,
  InvalidInboxStateError,
} from "../../../../src/domain/messaging/inbox-message.ts";
import { T0, at } from "../../../support/domain-builders.ts";

const HASH = "a".repeat(64);

describe("InboxMessage", () => {
  test("receive starts unprocessed", () => {
    const message = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-consumer",
      payloadHash: HASH,
      receivedAt: T0,
    });
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test("markProcessed once", () => {
    const message = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-consumer",
      payloadHash: HASH,
      receivedAt: T0,
    });
    message.markProcessed(at(10));
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(at(10));
    expect(() => {
      message.markProcessed(at(20));
    }).toThrow(InvalidInboxStateError);
  });

  test("same messageId with another payload does not match", () => {
    const message = InboxMessage.rehydrate({
      messageId: "msg-1",
      consumerName: "wager-consumer",
      payloadHash: HASH,
      receivedAt: T0,
      processedAt: T0,
    });
    expect(message.matchesPayload(HASH)).toBe(true);
    expect(message.matchesPayload("b".repeat(64))).toBe(false);
    expect(message.isProcessed()).toBe(true);
  });

  test("requires messageId and consumerName", () => {
    expect(() =>
      InboxMessage.receive({
        messageId: " ",
        consumerName: "c",
        payloadHash: HASH,
        receivedAt: T0,
      }),
    ).toThrow(InvalidInboxStateError);
    expect(() =>
      InboxMessage.receive({ messageId: "m", consumerName: "", payloadHash: HASH, receivedAt: T0 }),
    ).toThrow(InvalidInboxStateError);
  });
});
