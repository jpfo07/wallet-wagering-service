import { describe, expect, test } from "bun:test";
import { PublishOutboxBatch } from "../../../src/application/outbox/publish-outbox-batch.ts";
import type {
  EventPublisher,
  PublishOutcome,
} from "../../../src/application/ports/event-publisher.ts";
import type {
  OutboxPendingStats,
  OutboxRepository,
} from "../../../src/application/ports/repositories.ts";
import type { TransactionScope, UnitOfWork } from "../../../src/application/ports/unit-of-work.ts";
import { TransactionRunner } from "../../../src/application/transaction-runner.ts";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message.ts";
import { ExponentialBackoff } from "../../../src/domain/shared/backoff-policy.ts";
import {
  InMemoryApplicationMetrics,
  SilentLogger,
} from "../../../src/infrastructure/observability/telemetry-adapters.ts";
import { RecordingSleeper } from "../../support/application-suite.ts";

const T0 = new Date("2026-10-25T12:00:00.000Z");

function event(aggregateId: string, n: number): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: `${aggregateId}-e${n}`,
    aggregateId,
    eventType: "WalletBalanceChanged",
    payload: { eventId: `${aggregateId}-e${n}` },
    occurredAt: T0,
    attempts: 0,
    nextAttemptAt: T0,
  });
}

/** Returns the claimed messages in the given order and records every save. */
class FakeOutbox implements OutboxRepository {
  readonly saved: OutboxMessage[] = [];

  constructor(private readonly claimable: readonly OutboxMessage[]) {}

  enqueue(): Promise<void> {
    return Promise.resolve();
  }

  claimDue(): Promise<readonly OutboxMessage[]> {
    return Promise.resolve(this.claimable);
  }

  save(message: OutboxMessage): Promise<void> {
    this.saved.push(message);
    return Promise.resolve();
  }

  pendingStats(): Promise<OutboxPendingStats> {
    return Promise.resolve({ pendingCount: 0, oldestOccurredAt: undefined });
  }
}

/** Records each call (the ids it carried) and fails the ids in `failing`. */
class ScriptedPublisher implements EventPublisher {
  readonly calls: string[][] = [];

  constructor(private readonly failing: ReadonlySet<string> = new Set()) {}

  publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    this.calls.push(messages.map((message) => message.id));
    const published = new Set<string>();
    const failed = new Map<string, string>();
    for (const message of messages) {
      if (this.failing.has(message.id)) failed.set(message.id, "Scripted");
      else published.add(message.id);
    }
    return Promise.resolve({ published, failed });
  }
}

function batchFor(outbox: FakeOutbox, publisher: EventPublisher) {
  const uow: UnitOfWork = {
    run: (work) => work({ outbox } as unknown as TransactionScope),
  };
  const metrics = new InMemoryApplicationMetrics();
  const runner = new TransactionRunner(
    uow,
    { maxAttempts: 1, backoff: ExponentialBackoff.of({ baseMs: 1, maxMs: 1 }) },
    new RecordingSleeper(),
    { next: () => 0.5 },
    metrics,
    new SilentLogger(),
  );
  const batch = new PublishOutboxBatch(
    runner,
    publisher,
    { now: () => T0 },
    { next: () => 0 },
    {
      aggregates: 50,
      eventsPerAggregate: 10,
      retryBackoff: ExponentialBackoff.of({ baseMs: 1_000, maxMs: 60_000 }),
    },
    metrics,
    new SilentLogger(),
  );
  return { batch, metrics };
}

describe("PublishOutboxBatch", () => {
  test("each publish call carries at most one event per aggregate, in sequence order", async () => {
    const outbox = new FakeOutbox([event("a", 1), event("a", 2), event("a", 3), event("b", 1)]);
    const publisher = new ScriptedPublisher();
    const { batch, metrics } = batchFor(outbox, publisher);

    expect(await batch.execute()).toEqual({ claimed: 4, published: 4, failed: 0 });
    expect(publisher.calls).toEqual([["a-e1", "b-e1"], ["a-e2"], ["a-e3"]]);
    expect(outbox.saved.every((message) => message.publishedAt?.getTime() === T0.getTime())).toBe(
      true,
    );
    expect(metrics.count("outbox_published")).toBe(4);
  });

  test("a failed event stops its aggregate: the later ones are not sent nor touched", async () => {
    const outbox = new FakeOutbox([event("a", 1), event("a", 2), event("a", 3), event("b", 1)]);
    const publisher = new ScriptedPublisher(new Set(["a-e2"]));
    const { batch, metrics } = batchFor(outbox, publisher);

    expect(await batch.execute()).toEqual({ claimed: 4, published: 2, failed: 1 });
    expect(publisher.calls).toEqual([["a-e1", "b-e1"], ["a-e2"]]);
    expect(outbox.saved.map((message) => message.id)).toEqual(["a-e1", "b-e1", "a-e2"]);
    const retried = outbox.saved[2];
    expect(retried?.isPending()).toBe(true);
    expect(retried?.attempts).toBe(1);
    // Equal jitter with random() = 0: half of the base delay.
    expect(retried?.nextAttemptAt).toEqual(new Date(T0.getTime() + 500));
    expect(metrics.count("outbox_publish_failed{reason=Scripted}")).toBe(1);
  });

  test("a failed head blocks only its own aggregate", async () => {
    const outbox = new FakeOutbox([event("a", 1), event("a", 2), event("b", 1), event("b", 2)]);
    const publisher = new ScriptedPublisher(new Set(["a-e1"]));
    const { batch } = batchFor(outbox, publisher);

    expect(await batch.execute()).toEqual({ claimed: 4, published: 2, failed: 1 });
    expect(publisher.calls).toEqual([["a-e1", "b-e1"], ["b-e2"]]);
  });

  test("more than 10 aggregates in a layer are split into calls of at most 10", async () => {
    const heads = Array.from({ length: 23 }, (_, i) => event(`w${i}`, 1));
    const publisher = new ScriptedPublisher();
    const { batch } = batchFor(new FakeOutbox(heads), publisher);

    await batch.execute();
    expect(publisher.calls.map((call) => call.length)).toEqual([10, 10, 3]);
  });

  test("once the signal is aborted no new layer is sent; what was decided is kept", async () => {
    const outbox = new FakeOutbox([event("a", 1), event("a", 2)]);
    const controller = new AbortController();
    const publisher: EventPublisher = {
      publish: async (messages) => {
        const outcome = await new ScriptedPublisher().publish(messages);
        controller.abort();
        return outcome;
      },
    };
    const { batch } = batchFor(outbox, publisher);

    expect(await batch.execute(controller.signal)).toEqual({
      claimed: 2,
      published: 1,
      failed: 0,
    });
    expect(outbox.saved.map((message) => message.id)).toEqual(["a-e1"]);
  });
});
