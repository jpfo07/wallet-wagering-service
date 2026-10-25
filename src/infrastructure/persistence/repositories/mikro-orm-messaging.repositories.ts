import type { QueryResult } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  InboxRepository,
  OutboxPendingStats,
  OutboxRepository,
} from "../../../application/ports/repositories.ts";
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

// Raw queries (em.execute) bypass the ORM's type mapping: the driver hands timestamptz back as text.
type SqlTimestamp = Date | string;

interface OutboxSqlRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: SqlTimestamp;
  readonly attempts: number;
  readonly next_attempt_at: SqlTimestamp | null;
  readonly published_at: SqlTimestamp | null;
}

function toDate(value: SqlTimestamp): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PersistenceMappingError(`invalid timestamp from the database: ${String(value)}`);
  }
  return date;
}

function toOptionalDate(value: SqlTimestamp | null): Date | null {
  return value === null ? null : toDate(value);
}

const OUTBOX_COLUMNS =
  "id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at";

// The head of an aggregate is its oldest pending event (by sequence, never by occurred_at: clocks
// of different instances disagree). Only heads are claimable, so a publisher that skips a head
// locked by another one cannot take the next event of that aggregate: it is not a head while the
// locked one is pending. A head that waits for a retry (next_attempt_at in the future) also holds
// back the rest of its aggregate, on purpose (FIFO head-of-line).
const CLAIM_HEADS_SQL = `
  select o.aggregate_id
    from outbox_messages o
   where o.published_at is null
     and o.next_attempt_at <= ?
     and not exists (select 1 from outbox_messages p
                      where p.aggregate_id = o.aggregate_id
                        and p.published_at is null
                        and p.sequence < o.sequence)
   order by o.sequence
   limit ?
   for update of o skip locked`;

// Whoever holds the head owns the aggregate: nobody else can reach these rows, so a plain FOR
// UPDATE (re-entrant on the head) never waits. The array is a literal of UUIDs read just above.
const CLAIM_OWNED_SQL = `
  select m.${OUTBOX_COLUMNS.split(", ").join(", m.")}
    from unnest(?::uuid[]) with ordinality as a(aggregate_id, position)
    cross join lateral (
      select ${OUTBOX_COLUMNS}, sequence
        from outbox_messages e
       where e.aggregate_id = a.aggregate_id and e.published_at is null
       order by e.sequence
       limit ?
       for update
    ) m
   order by a.position, m.sequence`;

const PENDING_STATS_SQL = `
  select count(*)::int as pending_count, min(occurred_at) as oldest_occurred_at
    from outbox_messages where published_at is null`;

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxMessageRecord,
      messages.map((message) => OutboxMessageMapper.toRow(message)),
    );
  }

  async claimDue(
    now: Date,
    limits: { readonly aggregates: number; readonly eventsPerAggregate: number },
  ): Promise<readonly OutboxMessage[]> {
    const heads = await this.em.execute<{ aggregate_id: string }[]>(CLAIM_HEADS_SQL, [
      now,
      limits.aggregates,
    ]);
    if (heads.length === 0) return [];
    const rows = await this.em.execute<OutboxSqlRow[]>(CLAIM_OWNED_SQL, [
      `{${heads.map((head) => head.aggregate_id).join(",")}}`,
      limits.eventsPerAggregate,
    ]);
    return rows.map((row) =>
      OutboxMessageMapper.toDomain({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: toDate(row.occurred_at),
        attempts: row.attempts,
        nextAttemptAt: toOptionalDate(row.next_attempt_at),
        publishedAt: toOptionalDate(row.published_at),
      }),
    );
  }

  async save(message: OutboxMessage): Promise<void> {
    const row = OutboxMessageMapper.toRow(message);
    const updated = await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id, publishedAt: null },
      { attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, publishedAt: row.publishedAt },
    );
    if (updated !== 1) {
      throw new PersistenceMappingError(`outbox message ${message.id} was not pending`);
    }
  }

  async pendingStats(): Promise<OutboxPendingStats> {
    const rows =
      await this.em.execute<{ pending_count: number; oldest_occurred_at: SqlTimestamp | null }[]>(
        PENDING_STATS_SQL,
      );
    const row = rows[0];
    return {
      pendingCount: row?.pending_count ?? 0,
      oldestOccurredAt:
        row?.oldest_occurred_at == null ? undefined : toDate(row.oldest_occurred_at),
    };
  }
}
