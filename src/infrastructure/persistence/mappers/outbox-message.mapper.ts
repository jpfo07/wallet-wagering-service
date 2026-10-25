import { OutboxMessage } from "../../../domain/messaging/outbox-message.ts";
import type { OutboxMessageRow } from "../models/outbox-message.model.ts";

export const OutboxMessageMapper = {
  toDomain(row: OutboxMessageRow): OutboxMessage {
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

  toRow(message: OutboxMessage): OutboxMessageRow {
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
