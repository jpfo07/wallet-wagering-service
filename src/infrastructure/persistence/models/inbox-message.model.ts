import { defineEntity, p } from "@mikro-orm/postgresql";
import type { InferEntity } from "@mikro-orm/postgresql";

export const InboxMessageRecord = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.character().length(64),
    receivedAt: p.datetime(3),
    processedAt: p.datetime(3).nullable(),
  },
});

export type InboxMessageRow = InferEntity<typeof InboxMessageRecord>;
