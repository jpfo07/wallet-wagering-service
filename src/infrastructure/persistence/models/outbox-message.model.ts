import { defineEntity, p } from "@mikro-orm/postgresql";
import type { InferEntity } from "@mikro-orm/postgresql";

export const OutboxMessageRecord = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>().columnType("jsonb"),
    occurredAt: p.datetime(3),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(3).nullable(),
    publishedAt: p.datetime(3).nullable(),
  },
});

export type OutboxMessageRow = InferEntity<typeof OutboxMessageRecord>;
