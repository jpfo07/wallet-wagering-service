import type { OutboxMessage } from "../../domain/messaging/outbox-message.ts";
import type { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import { MAX_EVENTS_PER_PUBLISH } from "../ports/event-publisher.ts";
import type { EventPublisher, PublishOutcome } from "../ports/event-publisher.ts";
import type { OutboxPendingStats } from "../ports/repositories.ts";
import type { Clock, RandomSource } from "../ports/system.ts";
import type { ApplicationMetrics, Logger } from "../ports/telemetry.ts";
import type { TransactionScope } from "../ports/unit-of-work.ts";
import type { TransactionRunner } from "../transaction-runner.ts";

export interface OutboxPublishPolicy {
  /** Aggregates claimed per batch (one locked head each). */
  readonly aggregates: number;
  readonly eventsPerAggregate: number;
  /** Backoff of a failed event; there is no attempt limit. */
  readonly retryBackoff: ExponentialBackoff;
}

export interface OutboxBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

export interface OutboxLag {
  readonly pendingCount: number;
  /** 0 when nothing is pending. */
  readonly oldestPendingAgeMs: number;
}

/**
 * One batch of the transactional outbox, in one SQL transaction:
 *
 *   claim heads (FOR UPDATE SKIP LOCKED) + the next events of the owned aggregates → publish in
 *   layers → published: markPublished / failed: scheduleRetry → COMMIT
 *
 * Order per aggregate: layer k carries the k-th event of each aggregate still in play (at most one
 * per aggregate per publish call). When an event fails, the later ones of its aggregate are not
 * sent in this batch; they stay pending behind it. The broker therefore never receives E3 before
 * E2, and a failed head blocks only its own aggregate.
 *
 * Delivery is at-least-once: if the process dies after the broker accepted an event and before
 * COMMIT, the row is still pending (and still the head of its aggregate), so the next publisher
 * sends it again, in order. The broker deduplicates it by eventId within its window; after that
 * the consumer does, by eventId.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly policy: OutboxPublishPolicy,
    private readonly metrics: ApplicationMetrics,
    private readonly logger: Logger,
  ) {}

  /** `signal` aborted: no new layer is sent; what was decided so far is committed. */
  execute(signal?: AbortSignal): Promise<OutboxBatchResult> {
    return this.runner.run((scope) => this.publishBatch(scope, signal));
  }

  async measureLag(): Promise<OutboxLag> {
    const stats: OutboxPendingStats = await this.runner.run(
      (scope) => scope.outbox.pendingStats(),
      { readOnly: true },
    );
    const oldest = stats.oldestOccurredAt;
    const oldestPendingAgeMs =
      oldest === undefined ? 0 : Math.max(0, this.clock.now().getTime() - oldest.getTime());
    this.metrics.outboxLag(oldestPendingAgeMs, stats.pendingCount);
    return { pendingCount: stats.pendingCount, oldestPendingAgeMs };
  }

  private async publishBatch(
    scope: TransactionScope,
    signal: AbortSignal | undefined,
  ): Promise<OutboxBatchResult> {
    const claimed = await scope.outbox.claimDue(this.clock.now(), {
      aggregates: this.policy.aggregates,
      eventsPerAggregate: this.policy.eventsPerAggregate,
    });
    const lanes = byAggregate(claimed);
    let published = 0;
    let failed = 0;

    while (lanes.size > 0 && signal?.aborted !== true) {
      const layer = [...lanes.values()].map((lane) => lane.shift()).filter(isDefined);
      const outcomes = await Promise.all(
        chunk(layer, MAX_EVENTS_PER_PUBLISH).map((messages) => this.publisher.publish(messages)),
      );
      const outcome = merge(outcomes);
      // Saved layer by layer: the transaction never stays idle longer than one publish call.
      const now = this.clock.now();
      for (const message of layer) {
        if (outcome.published.has(message.id)) {
          message.markPublished(now);
          published += 1;
        } else {
          const reason = outcome.failed.get(message.id) ?? "not confirmed";
          message.scheduleRetry(now, this.policy.retryBackoff, () => this.random.next());
          failed += 1;
          lanes.delete(message.aggregateId);
          this.metrics.outboxPublishFailed(reason);
          this.logger.warn("outbox event not published, retry scheduled", {
            eventId: message.id,
            eventType: message.eventType,
            walletId: message.aggregateId,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            reason,
          });
        }
        await scope.outbox.save(message);
        const lane = lanes.get(message.aggregateId);
        if (lane?.length === 0) lanes.delete(message.aggregateId);
      }
    }
    if (published > 0) this.metrics.outboxPublished(published);
    return { claimed: claimed.length, published, failed };
  }
}

/** Lanes per aggregate, each in publication order (claimDue already returns that order). */
function byAggregate(messages: readonly OutboxMessage[]): Map<string, OutboxMessage[]> {
  const lanes = new Map<string, OutboxMessage[]>();
  for (const message of messages) {
    const lane = lanes.get(message.aggregateId);
    if (lane === undefined) lanes.set(message.aggregateId, [message]);
    else lane.push(message);
  }
  return lanes;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function merge(outcomes: readonly PublishOutcome[]): PublishOutcome {
  const published = new Set<string>();
  const failed = new Map<string, string>();
  for (const outcome of outcomes) {
    for (const id of outcome.published) published.add(id);
    for (const [id, reason] of outcome.failed) failed.set(id, reason);
  }
  return { published, failed };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
