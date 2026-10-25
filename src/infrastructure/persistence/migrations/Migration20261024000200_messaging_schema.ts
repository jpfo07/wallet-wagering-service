import { Migration } from "@mikro-orm/migrations";

/**
 * Inbox (persistent dedup of SQS deliveries) and transactional outbox. Both are written in the same
 * SQL transaction as the financial change they belong to.
 */
export class Migration20261024000200_messaging_schema extends Migration {
  override up(): void {
    for (const statement of UP) this.addSql(statement);
  }

  override down(): void {
    for (const statement of DOWN) this.addSql(statement);
  }
}

const UP: readonly string[] = [
  `CREATE TABLE inbox_messages (
    consumer_name text           NOT NULL,
    message_id    text           NOT NULL,
    payload_hash  char(64)       NOT NULL,
    received_at   timestamptz(3) NOT NULL,
    processed_at  timestamptz(3) NULL,
    CONSTRAINT inbox_messages_pk               PRIMARY KEY (consumer_name, message_id),
    CONSTRAINT inbox_messages_payload_hash_chk CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT inbox_messages_text_fields_chk  CHECK (
          consumer_name ~ '\\S' AND char_length(consumer_name) <= 255
      AND message_id ~ '\\S' AND char_length(message_id) <= 255)
  )`,

  // id = eventId (SQS MessageDeduplicationId); aggregate_id = walletId (MessageGroupId).
  // A pending message always has next_attempt_at, so no committed event can fall outside the
  // publisher's query; a published one has none.
  `CREATE TABLE outbox_messages (
    id              uuid           NOT NULL,
    aggregate_id    uuid           NOT NULL,
    event_type      text           NOT NULL,
    payload         jsonb          NOT NULL,
    occurred_at     timestamptz(3) NOT NULL,
    attempts        integer        NOT NULL,
    next_attempt_at timestamptz(3) NULL,
    published_at    timestamptz(3) NULL,
    CONSTRAINT outbox_messages_pk             PRIMARY KEY (id),
    CONSTRAINT outbox_messages_attempts_chk   CHECK (attempts >= 0),
    CONSTRAINT outbox_messages_event_type_chk CHECK (event_type ~ '\\S' AND char_length(event_type) <= 255),
    CONSTRAINT outbox_messages_payload_chk    CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT outbox_messages_schedule_chk   CHECK ((published_at IS NULL) = (next_attempt_at IS NOT NULL))
  )`,
  `CREATE INDEX outbox_messages_pending_idx ON outbox_messages (next_attempt_at)
     WHERE published_at IS NULL`,
];

const DOWN: readonly string[] = [`DROP TABLE outbox_messages`, `DROP TABLE inbox_messages`];
