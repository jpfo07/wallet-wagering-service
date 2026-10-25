import type { OutboxMessage } from "../../domain/messaging/outbox-message.ts";

/** Upper bound of one publish call (SQS SendMessageBatch accepts 10 entries). */
export const MAX_EVENTS_PER_PUBLISH = 10;

export interface PublishOutcome {
  /** Ids (eventIds) accepted by the broker. */
  readonly published: ReadonlySet<string>;
  /** Ids refused or not confirmed, with a short reason for logs and metrics. */
  readonly failed: ReadonlyMap<string, string>;
}

/**
 * Sends outbox events to the broker. Every id of the batch ends in exactly one of the two sets:
 * the adapter never throws (a request that fails as a whole fails every id). The caller gives at
 * most one event per aggregate per call, so a partial failure can never put a later event of an
 * aggregate ahead of an earlier one.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome>;
}
