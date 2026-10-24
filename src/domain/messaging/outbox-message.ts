import type { IntegrationEvent } from "../events/integration-event.ts";
import { addMilliseconds } from "../shared/backoff-policy.ts";
import type { ExponentialBackoff } from "../shared/backoff-policy.ts";
import { deepFreeze } from "../shared/deep-freeze.ts";
import { InvariantViolationError } from "../shared/domain-error.ts";

export class InvalidOutboxStateError extends InvariantViolationError {
  constructor(message: string) {
    super("INVALID_OUTBOX_STATE", message);
  }
}

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly publishedAt?: Date | undefined;
}

/**
 * An event waiting to be published, written in the same SQL transaction as the financial change.
 * There is no attempt limit: giving up would lose a committed event. The backoff ceiling bounds
 * the cost, and the outbox-lag metric is what raises the alarm.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** id = eventId, which is also the SQS MessageDeduplicationId and the consumer's dedup key. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      deepFreeze({ ...event.toJSON() }),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending("markPublished");
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and computes the next attempt time (exponential backoff with jitter). */
  scheduleRetry(now: Date, backoff: ExponentialBackoff, random: () => number): void {
    this.assertPending("scheduleRetry");
    const delay = backoff.delayFor(this._attempts, random);
    this._attempts += 1;
    this._nextAttemptAt = addMilliseconds(now, delay);
  }

  private assertPending(operation: string): void {
    if (this._publishedAt !== undefined) {
      throw new InvalidOutboxStateError(
        `outbox message ${this.id} is published; cannot ${operation}`,
      );
    }
  }
}
