import { OutboxMessage } from "../../../domain/messaging/outbox-message.ts";
import type { OutboxMessageRow } from "../models/outbox-message.model.ts";

/** The columns the application writes; `sequence` is assigned by PostgreSQL. */
export type OutboxMessageWritableRow = Omit<OutboxMessageRow, "sequence">;

export const OutboxMessageMapper = {
  toDomain(row: OutboxMessageWritableRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt ?? undefined,
      publishedAt: row.publishedAt ?? undefined,
    });
  },

  toRow(message: OutboxMessage): OutboxMessageWritableRow {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    };
  },
};
