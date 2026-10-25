import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import type { PublishOutboxBatch } from "../../src/application/outbox/publish-outbox-batch.ts";
import type {
  EventPublisher,
  PublishOutcome,
} from "../../src/application/ports/event-publisher.ts";
import type { Clock } from "../../src/application/ports/system.ts";
import type { OutboxMessage } from "../../src/domain/messaging/outbox-message.ts";
import { buildPublishOutboxBatch } from "../../src/infrastructure/application/composition.ts";
import type { Application } from "../../src/infrastructure/application/composition.ts";
import type { OutboxPublisherConfig } from "../../src/infrastructure/config/env.ts";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher.ts";
import { waitFor } from "./polling.ts";
import { TEST_OUTBOX_PUBLISHER } from "./test-env.ts";

/** A clock the test moves by hand (TTL, backoff and clock-skew scenarios without sleeping). */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: Date): void {
    this.current = at.getTime();
  }
}

/** The real SQS publisher with some event ids refused (a broker refusing those entries). */
export class RefusingPublisher implements EventPublisher {
  constructor(
    private readonly inner: EventPublisher,
    readonly refused: Set<string> = new Set(),
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    const allowed = messages.filter((message) => !this.refused.has(message.id));
    const outcome = await this.inner.publish(allowed);
    const failed = new Map(outcome.failed);
    for (const message of messages) {
      if (this.refused.has(message.id)) failed.set(message.id, "Refused");
    }
    return { published: outcome.published, failed };
  }
}

export function outboxPublisherFor(
  app: Application,
  publisher: EventPublisher,
  config: Partial<OutboxPublisherConfig> = {},
): PublishOutboxBatch {
  return buildPublishOutboxBatch(app, publisher, { ...TEST_OUTBOX_PUBLISHER, ...config });
}

export function sqsPublisher(sqs: SQSClient, queueUrl: string): SqsEventPublisher {
  return new SqsEventPublisher(sqs, queueUrl);
}

export interface ReceivedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly groupId: string | undefined;
  readonly deduplicationId: string | undefined;
  readonly eventTypeAttribute: string | undefined;
  readonly body: Record<string, unknown>;
}

/**
 * Receives (and deletes) from the events queue until `expected` messages arrived, then keeps
 * polling for `settleMs` to catch any extra copy. Returns everything, in the order received.
 */
export async function drainEvents(
  sqs: SQSClient,
  queueUrl: string,
  expected: number,
  { timeoutMs = 20_000, settleMs = 1_500 }: { timeoutMs?: number; settleMs?: number } = {},
): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  const receiveOnce = async (waitTimeSeconds: number): Promise<void> => {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ["MessageGroupId", "MessageDeduplicationId"],
        MessageAttributeNames: ["All"],
      }),
    );
    for (const message of Messages ?? []) {
      const body = JSON.parse(message.Body ?? "{}") as Record<string, unknown>;
      received.push({
        eventId: String(body["eventId"]),
        eventType: String(body["eventType"]),
        aggregateId: String(body["aggregateId"]),
        groupId: message.Attributes?.["MessageGroupId"],
        deduplicationId: message.Attributes?.["MessageDeduplicationId"],
        eventTypeAttribute: message.MessageAttributes?.["eventType"]?.StringValue,
        body,
      });
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  };
  await waitFor(
    async () => {
      await receiveOnce(1);
      return received.length >= expected;
    },
    { timeoutMs, intervalMs: 1, description: `${expected} events on ${queueUrl}` },
  );
  const settleUntil = Date.now() + settleMs;
  while (Date.now() < settleUntil) await receiveOnce(1);
  return received;
}

export interface OutboxRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly sequence: string;
  readonly attempts: number;
  readonly next_attempt_at: Date | null;
  readonly published_at: Date | null;
  readonly transaction_id: string | null;
}

/** Outbox rows (all, or of one wallet), in publication order. */
export async function outboxRows(sql: SQL, walletId?: string): Promise<OutboxRow[]> {
  return sql.unsafe(
    `select o.id, o.aggregate_id, o.event_type, o.sequence::text as sequence, o.attempts,
            o.next_attempt_at, o.published_at, o.payload->'data'->>'transactionId' as transaction_id
       from outbox_messages o
      where $1::uuid is null or o.aggregate_id = $1::uuid
      order by o.sequence`,
    [walletId ?? null],
  );
}

export async function pendingOutboxCount(sql: SQL): Promise<number> {
  const rows: { n: number }[] = await sql.unsafe(
    "select count(*)::int as n from outbox_messages where published_at is null",
  );
  return rows[0]?.n ?? 0;
}

/** Order of the received events of each aggregate, to compare with the outbox sequence. */
export function receivedOrderByAggregate(events: readonly ReceivedEvent[]): Map<string, string[]> {
  const order = new Map<string, string[]>();
  for (const event of events) {
    const ids = order.get(event.aggregateId) ?? [];
    ids.push(event.eventId);
    order.set(event.aggregateId, ids);
  }
  return order;
}

export function outboxOrderByAggregate(rows: readonly OutboxRow[]): Map<string, string[]> {
  const order = new Map<string, string[]>();
  for (const row of rows) {
    const ids = order.get(row.aggregate_id) ?? [];
    ids.push(row.id);
    order.set(row.aggregate_id, ids);
  }
  return order;
}
