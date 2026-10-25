import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SQSClient, SendMessageBatchRequestEntry } from "@aws-sdk/client-sqs";
import { MAX_EVENTS_PER_PUBLISH } from "../../application/ports/event-publisher.ts";
import type { EventPublisher, PublishOutcome } from "../../application/ports/event-publisher.ts";
import type { OutboxMessage } from "../../domain/messaging/outbox-message.ts";

/**
 * Publishes outbox events to wallet-events.fifo with SendMessageBatch:
 * MessageGroupId = aggregateId (walletId), so a consumer gets the events of a wallet in order, and
 * MessageDeduplicationId = eventId, so a re-publication after a crash is dropped by SQS within its
 * deduplication window (5 min). The body is the serialized envelope stored in the outbox.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    if (messages.length === 0) return { published: new Set(), failed: new Map() };
    if (messages.length > MAX_EVENTS_PER_PUBLISH) {
      throw new RangeError(`at most ${MAX_EVENTS_PER_PUBLISH} events per publish`);
    }
    // Batch entry ids only need to be unique inside the request.
    const byEntryId = new Map(messages.map((message, index) => [`e${index}`, message]));
    const published = new Set<string>();
    const failed = new Map<string, string>();
    try {
      const response = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: [...byEntryId].map(([entryId, message]) => toEntry(entryId, message)),
        }),
      );
      for (const entry of response.Successful ?? []) {
        const message = entry.Id === undefined ? undefined : byEntryId.get(entry.Id);
        if (message !== undefined) published.add(message.id);
      }
      for (const entry of response.Failed ?? []) {
        const message = entry.Id === undefined ? undefined : byEntryId.get(entry.Id);
        if (message !== undefined) failed.set(message.id, entry.Code ?? "BatchEntryFailed");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.name : "SendMessageBatchFailed";
      for (const message of messages) failed.set(message.id, reason);
    }
    // An entry SQS reported in neither list is not confirmed: retry it (dedup makes it safe).
    for (const message of messages) {
      if (!published.has(message.id) && !failed.has(message.id)) {
        failed.set(message.id, "NotConfirmed");
      }
    }
    return { published, failed };
  }
}

function toEntry(entryId: string, message: OutboxMessage): SendMessageBatchRequestEntry {
  const correlationId = message.payload["correlationId"];
  return {
    Id: entryId,
    MessageBody: JSON.stringify(message.payload),
    MessageGroupId: message.aggregateId,
    MessageDeduplicationId: message.id,
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: message.eventType },
      ...(typeof correlationId === "string" && correlationId !== ""
        ? { correlationId: { DataType: "String", StringValue: correlationId } }
        : {}),
    },
  };
}
