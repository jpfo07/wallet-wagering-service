import type { QueryResult } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository, OutboxRepository } from "../../../application/ports/repositories.ts";
import type { InboxMessage } from "../../../domain/messaging/inbox-message.ts";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message.ts";
import { InboxMessageMapper } from "../mappers/inbox-message.mapper.ts";
import { OutboxMessageMapper } from "../mappers/outbox-message.mapper.ts";
import { PersistenceMappingError } from "../mappers/persistence-mapping.error.ts";
import { InboxMessageRecord } from "../models/inbox-message.model.ts";
import { OutboxMessageRecord } from "../models/outbox-message.model.ts";

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async receive(
    message: InboxMessage,
  ): Promise<{ readonly message: InboxMessage; readonly inserted: boolean }> {
    // ON CONFLICT DO NOTHING waits for a concurrent insert of the same key and then does nothing,
    // so a redelivery racing the first delivery never raises 23505 here.
    const result = await this.em
      .createQueryBuilder(InboxMessageRecord)
      .insert(InboxMessageMapper.toRow(message))
      .onConflict(["consumerName", "messageId"])
      .ignore()
      .execute<QueryResult>("run");
    if (result.affectedRows > 0) return { message, inserted: true };
    const row = await this.em.findOne(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { disableIdentityMap: true },
    );
    if (row === null) {
      throw new PersistenceMappingError(
        `inbox ${message.consumerName}/${message.messageId}: conflict reported but no row found`,
      );
    }
    return { message: InboxMessageMapper.toDomain(row), inserted: false };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const processedAt = message.processedAt;
    if (processedAt === undefined) {
      throw new PersistenceMappingError(`inbox ${message.messageId} is not processed`);
    }
    const updated = await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId, processedAt: null },
      { processedAt },
    );
    if (updated !== 1) {
      throw new PersistenceMappingError(
        `inbox ${message.consumerName}/${message.messageId} was not pending`,
      );
    }
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxMessageRecord,
      messages.map((message) => OutboxMessageMapper.toRow(message)),
    );
  }
}
