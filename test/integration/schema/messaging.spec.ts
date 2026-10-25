import { describe, expect, test } from "bun:test";
import { SQLSTATE, expectViolation } from "../../support/constraint-assertions.ts";
import { useSchemaSuite } from "../../support/schema-suite.ts";
import { HASH, T0, insertRow, uuid } from "../../support/sql-fixtures.ts";
import type { Row } from "../../support/sql-fixtures.ts";

const suite = useSchemaSuite("schema-messaging");
const check = (constraint: string) => ({ sqlState: SQLSTATE.checkViolation, constraint });

const inboxRow = (overrides: Row = {}): Row => ({
  consumer_name: "wager-consumer",
  message_id: `msg-${uuid()}`,
  payload_hash: HASH,
  received_at: T0,
  processed_at: T0,
  ...overrides,
});

const outboxRow = (overrides: Row = {}): Row => ({
  id: uuid(),
  aggregate_id: uuid(),
  event_type: "WalletBalanceChanged",
  payload: { eventType: "WalletBalanceChanged", data: { amount: "10.00" } },
  occurred_at: T0,
  attempts: 0,
  next_attempt_at: T0,
  published_at: null,
  ...overrides,
});

describe("inbox_messages", () => {
  test("the same (consumer, messageId) twice", async () => {
    const { sql } = suite();
    const row = inboxRow();
    await insertRow(sql, "inbox_messages", row);
    await expectViolation(
      () => insertRow(sql, "inbox_messages", inboxRow({ message_id: row["message_id"] })),
      {
        sqlState: SQLSTATE.uniqueViolation,
        constraint: "inbox_messages_pk",
      },
    );
  });

  test("the same messageId for another consumer is another delivery", async () => {
    const { sql } = suite();
    const row = inboxRow();
    await insertRow(sql, "inbox_messages", row);
    await insertRow(
      sql,
      "inbox_messages",
      inboxRow({ message_id: row["message_id"], consumer_name: "other" }),
    );
  });

  test.each<[string, Row, string]>([
    [
      "payload hash that is not hex",
      { payload_hash: "z".repeat(64) },
      "inbox_messages_payload_hash_chk",
    ],
    ["blank message id", { message_id: " " }, "inbox_messages_text_fields_chk"],
    [
      "consumer name longer than 255",
      { consumer_name: "c".repeat(256) },
      "inbox_messages_text_fields_chk",
    ],
  ])("%s", async (_label, overrides, constraint) => {
    await expectViolation(
      () => insertRow(suite().sql, "inbox_messages", inboxRow(overrides)),
      check(constraint),
    );
  });
});

describe("outbox_messages", () => {
  test.each<[string, Row, string]>([
    ["pending without next_attempt_at", { next_attempt_at: null }, "outbox_messages_schedule_chk"],
    ["published but still scheduled", { published_at: T0 }, "outbox_messages_schedule_chk"],
    ["negative attempts", { attempts: -1 }, "outbox_messages_attempts_chk"],
    [
      "payload that is not a JSON object",
      { payload: ["not", "an", "object"] },
      "outbox_messages_payload_chk",
    ],
    ["blank event type", { event_type: "" }, "outbox_messages_event_type_chk"],
  ])("%s", async (_label, overrides, constraint) => {
    await expectViolation(
      () => insertRow(suite().sql, "outbox_messages", outboxRow(overrides)),
      check(constraint),
    );
  });

  test("the same eventId twice", async () => {
    const { sql } = suite();
    const row = outboxRow();
    await insertRow(sql, "outbox_messages", row);
    await expectViolation(() => insertRow(sql, "outbox_messages", outboxRow({ id: row["id"] })), {
      sqlState: SQLSTATE.uniqueViolation,
      constraint: "outbox_messages_pk",
    });
  });

  test("retry then markPublished (publisher path) are accepted", async () => {
    const { sql } = suite();
    const row = outboxRow();
    await insertRow(sql, "outbox_messages", row);
    await sql.unsafe(
      "update outbox_messages set attempts = 1, next_attempt_at = $2 where id = $1",
      [row["id"], new Date(T0.getTime() + 1_000)],
    );
    await sql.unsafe(
      "update outbox_messages set published_at = $2, next_attempt_at = null where id = $1",
      [row["id"], T0],
    );
    const pending: unknown[] = await sql.unsafe(
      "select 1 from outbox_messages where id = $1 and published_at is null",
      [row["id"]],
    );
    expect(pending).toHaveLength(0);
  });
});
