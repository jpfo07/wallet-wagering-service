import { InboxMessage } from "../../../domain/messaging/inbox-message.ts";
import type { InboxMessageRow } from "../models/inbox-message.model.ts";

export const InboxMessageMapper = {
  toDomain(row: InboxMessageRow): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: row.messageId,
      consumerName: row.consumerName,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt ?? undefined,
    });
  },

  toRow(message: InboxMessage): InboxMessageRow {
    return {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    };
  },
};
