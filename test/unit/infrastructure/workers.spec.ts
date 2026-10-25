import { describe, expect, test } from "bun:test";
import { ExponentialBackoff } from "../../../src/domain/shared/backoff-policy.ts";
import { shutdownTimeoutMs } from "../../../src/entrypoints/run-worker.ts";
import { ConfigError, loadConfig } from "../../../src/infrastructure/config/env.ts";
import { SilentLogger } from "../../../src/infrastructure/observability/telemetry-adapters.ts";
import { PollingLoop } from "../../../src/infrastructure/workers/polling-loop.ts";
import type { PollingTask } from "../../../src/infrastructure/workers/polling-loop.ts";
import { assertOutboxTimeouts } from "../../../src/infrastructure/workers/start-outbox-publisher.ts";

const REQUIRED = {
  DATABASE_HOST: "db",
  DATABASE_NAME: "wallet",
  DATABASE_USER: "wallet",
  DATABASE_PASSWORD: "wallet",
};

describe("worker configuration", () => {
  test("defaults of the outbox publisher, the pending-reference worker and the idle timeout", () => {
    const config = loadConfig(REQUIRED);
    expect(config.database.idleInTransactionTimeoutMs).toBe(30_000);
    expect(config.outboxPublisher).toEqual({
      batchAggregates: 50,
      maxEventsPerAggregate: 10,
      pollIntervalMs: 200,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
      sqsRequestTimeoutMs: 5_000,
      errorPauseBaseMs: 500,
      errorPauseMaxMs: 30_000,
    });
    expect(config.pendingReferenceWorker).toEqual({
      batchSize: 50,
      pollIntervalMs: 500,
      errorPauseBaseMs: 500,
      errorPauseMaxMs: 30_000,
    });
  });

  test("zero batch sizes are refused", () => {
    expect(() => loadConfig({ ...REQUIRED, OUTBOX_BATCH_AGGREGATES: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...REQUIRED, PENDING_REFERENCE_BATCH_SIZE: "0" })).toThrow(
      ConfigError,
    );
  });

  test("the SQS request timeout must fit inside idle_in_transaction_session_timeout", () => {
    const config = loadConfig(REQUIRED);
    expect(() => {
      assertOutboxTimeouts(config.outboxPublisher, config.database);
    }).not.toThrow();
    expect(() => {
      assertOutboxTimeouts(
        { ...config.outboxPublisher, sqsRequestTimeoutMs: 30_000 },
        config.database,
      );
    }).toThrow(ConfigError);
  });

  test("the shutdown deadline covers what each loop may still be doing", () => {
    const config = loadConfig(REQUIRED);
    // drain 8 s vs long poll 5 s → 8 s + 4 s margin
    expect(shutdownTimeoutMs("sqs-consumer", config)).toBe(12_000);
    // one SQS call (5 s) + 4 s, raised to the 10 s minimum
    expect(shutdownTimeoutMs("outbox-publisher", config)).toBe(10_000);
    // 3 attempts × (5 s lock_timeout + 0.4 s backoff) + 4 s
    expect(shutdownTimeoutMs("pending-reference-worker", config)).toBe(20_200);
  });
});

function loop(task: PollingTask, pollIntervalMs: number): PollingLoop {
  return new PollingLoop(
    task,
    {
      name: "test",
      pollIntervalMs,
      errorBackoff: ExponentialBackoff.of({ baseMs: 10, maxMs: 20 }),
    },
    { next: () => 0 },
    new SilentLogger(),
  );
}

describe("PollingLoop", () => {
  test("a productive cycle runs again at once; an idle one waits; stop() wakes the wait", async () => {
    let cycles = 0;
    let idle!: () => void;
    const reachedIdle = new Promise<void>((resolve) => (idle = resolve));
    const polling = loop(() => {
      cycles += 1;
      if (cycles < 3) return Promise.resolve(true);
      idle();
      return Promise.resolve(false);
    }, 60_000);
    polling.start();
    await reachedIdle;
    const stopping = Date.now();
    await polling.stop();
    expect(cycles).toBe(3);
    expect(Date.now() - stopping).toBeLessThan(1_000);
  });

  test("a failing cycle is retried after a pause, without giving up", async () => {
    let cycles = 0;
    let recovered!: () => void;
    const done = new Promise<void>((resolve) => (recovered = resolve));
    const polling = loop(() => {
      cycles += 1;
      if (cycles <= 3) return Promise.reject(new Error("database down"));
      recovered();
      return Promise.resolve(false);
    }, 60_000);
    polling.start();
    await done;
    await polling.stop();
    expect(cycles).toBe(4);
  });

  test("stop() waits for the cycle in progress and signals it", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => (finish = resolve));
    let observed: AbortSignal | undefined;
    let started!: () => void;
    const isRunning = new Promise<void>((resolve) => (started = resolve));
    let finished = false;
    const polling = loop(async (signal) => {
      observed = signal;
      started();
      await blocked;
      finished = true;
      return false;
    }, 60_000);
    polling.start();
    await isRunning;
    const stopped = polling.stop();
    expect(observed?.aborted).toBe(true);
    finish();
    await stopped;
    expect(finished).toBe(true);
  });
});
