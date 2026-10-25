import { describe, expect, test } from "bun:test";
import { ConnectionException, DriverException } from "@mikro-orm/core";
import { ExponentialBackoff } from "../../../../src/domain/shared/backoff-policy.ts";
import { withConnectionRetry } from "../../../../src/infrastructure/persistence/connection-retry.ts";

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

function harness(attempts = 4) {
  const sleeps: number[] = [];
  const retries: string[] = [];
  return {
    sleeps,
    retries,
    options: {
      attempts,
      backoff: ExponentialBackoff.of({ baseMs: 100, maxMs: 400 }),
      sleeper: { sleep: (ms: number) => Promise.resolve(void sleeps.push(ms)) },
      random: { next: () => 0 },
      onRetry: ({ reason }: { reason: string }) => void retries.push(reason),
    },
  };
}

/** Fails with the given errors, in order, then succeeds. */
function failingWith(...errors: Error[]) {
  let calls = 0;
  const work = (): Promise<string> => {
    const error = errors[calls++];
    return error === undefined ? Promise.resolve("done") : Promise.reject(error);
  };
  return { work, calls: () => calls };
}

describe("withConnectionRetry", () => {
  test("database starting up (57P03), connection lost (08006) and refused: retried with backoff", async () => {
    const { options, sleeps, retries } = harness();
    const econnrefused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { work, calls } = failingWith(
      new DriverException(pgError("57P03")),
      pgError("08006"),
      econnrefused,
    );

    expect(await withConnectionRetry(work, options)).toBe("done");
    expect(calls()).toBe(4);
    expect(retries).toEqual(["57P03", "08006", "ECONNREFUSED"]);
    expect(sleeps).toEqual([50, 100, 200]); // equal jitter with random 0: half of 100, 200, 400
  });

  test("ConnectionException without SQLSTATE is a connection failure", async () => {
    const { options } = harness();
    const { work, calls } = failingWith(new ConnectionException(new Error("no route")));
    expect(await withConnectionRetry(work, options)).toBe("done");
    expect(calls()).toBe(2);
  });

  test("gives up after the attempt limit and throws the last error", async () => {
    const { options, sleeps } = harness(3);
    const last = pgError("57P03");
    const { work, calls } = failingWith(pgError("57P03"), pgError("57P03"), last, pgError("57P03"));
    const thrown = await withConnectionRetry(work, options).catch((e: unknown) => e);
    expect(thrown).toBe(last);
    expect(calls()).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  test.each([
    ["55P03", "lock timeout: a busy database, not an unreachable one"],
    ["40P01", "deadlock"],
    ["23505", "integrity"],
    ["42P01", "undefined table (a broken migration)"],
  ])("%s (%s) is not retried", async (code) => {
    const { options, sleeps } = harness();
    const error = pgError(code);
    const { work, calls } = failingWith(error);
    const thrown = await withConnectionRetry(work, options).catch((e: unknown) => e);
    expect(thrown).toBe(error);
    expect(calls()).toBe(1);
    expect(sleeps).toHaveLength(0);
  });
});
