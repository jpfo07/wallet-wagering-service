import { describe, expect, test } from "bun:test";
import {
  PersistenceIntegrityError,
  TransientFailureError,
  TransientPersistenceError,
} from "../../../src/application/errors.ts";
import type { TransactionScope, UnitOfWork } from "../../../src/application/ports/unit-of-work.ts";
import { TransactionRunner } from "../../../src/application/transaction-runner.ts";
import { ExponentialBackoff } from "../../../src/domain/shared/backoff-policy.ts";
import { InMemoryApplicationMetrics, SilentLogger } from "../../support/in-memory-telemetry.ts";
import { RecordingSleeper } from "../../support/application-suite.ts";

/** Scripted unit of work: each attempt throws the next scripted error, or succeeds when exhausted. */
class ScriptedUnitOfWork implements UnitOfWork {
  attempts = 0;

  constructor(private readonly failures: readonly Error[]) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const failure = this.failures[this.attempts];
    this.attempts += 1;
    if (failure !== undefined) throw failure;
    return work({} as TransactionScope);
  }
}

function runnerFor(uow: UnitOfWork, maxAttempts = 3) {
  const sleeper = new RecordingSleeper();
  const metrics = new InMemoryApplicationMetrics();
  const runner = new TransactionRunner(
    uow,
    { maxAttempts, backoff: ExponentialBackoff.of({ baseMs: 100, maxMs: 400 }) },
    sleeper,
    { next: () => 0.5 },
    metrics,
    new SilentLogger(),
  );
  return { runner, sleeper, metrics };
}

const transient = (reason: string) => new TransientPersistenceError(reason, new Error(reason));

describe("TransactionRunner", () => {
  test("transient errors are retried with exponential backoff, then the attempt succeeds", async () => {
    const uow = new ScriptedUnitOfWork([transient("55P03"), transient("40P01")]);
    const { runner, sleeper, metrics } = runnerFor(uow);
    expect(await runner.run(() => Promise.resolve("ok"))).toBe("ok");
    expect(uow.attempts).toBe(3);
    // equal jitter with random = 0.5: 75% of 100, then 75% of 200.
    expect(sleeper.delays).toEqual([75, 150]);
    expect(metrics.count("transient_retry{reason=55P03}")).toBe(1);
    expect(metrics.count("transient_retry{reason=40P01}")).toBe(1);
  });

  test("the budget is bounded: after maxAttempts it gives up with TransientFailureError", async () => {
    const uow = new ScriptedUnitOfWork([
      transient("55P03"),
      transient("55P03"),
      transient("55P03"),
    ]);
    const { runner, sleeper } = runnerFor(uow);
    const error = await runner.run(() => Promise.resolve("never")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientFailureError);
    expect((error as TransientFailureError).attempts).toBe(3);
    expect((error as TransientFailureError).cause).toBeInstanceOf(TransientPersistenceError);
    expect(uow.attempts).toBe(3);
    expect(sleeper.delays).toHaveLength(2);
  });

  test.each([
    ["integrity error", new PersistenceIntegrityError("23514", "wallets_matches_ledger", null)],
    ["any other error", new Error("bug")],
  ])("%s is never retried", async (_label, failure) => {
    const uow = new ScriptedUnitOfWork([failure]);
    const { runner, sleeper } = runnerFor(uow);
    const error = await runner.run(() => Promise.resolve("never")).catch((e: unknown) => e);
    expect(error).toBe(failure);
    expect(uow.attempts).toBe(1);
    expect(sleeper.delays).toEqual([]);
  });
});
