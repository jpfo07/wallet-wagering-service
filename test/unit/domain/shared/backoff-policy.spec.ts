import { describe, expect, test } from "bun:test";
import { ExponentialBackoff } from "../../../../src/domain/shared/backoff-policy.ts";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error.ts";

const backoff = ExponentialBackoff.of({ baseMs: 1_000, maxMs: 60_000 });

describe("ExponentialBackoff", () => {
  test("doubles from the base up to the ceiling (upper bound of the jitter)", () => {
    const upper = [0, 1, 2, 3, 4, 5, 6, 7, 30].map((attempt) =>
      backoff.delayFor(attempt, () => 0.999_999),
    );
    expect(upper).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  test("equal jitter: between half and the whole ceiling", () => {
    expect(backoff.delayFor(2, () => 0)).toBe(2_000);
    expect(backoff.delayFor(2, () => 0.5)).toBe(3_000);
  });

  test("survives a huge attempt number without overflowing", () => {
    expect(backoff.delayFor(10_000, () => 0.999_999)).toBe(60_000);
  });

  test.each([[{ baseMs: 0, maxMs: 10 }], [{ baseMs: 10, maxMs: 5 }], [{ baseMs: 1.5, maxMs: 10 }]])(
    "rejects configuration %p",
    (config) => {
      expect(() => ExponentialBackoff.of(config)).toThrow(InvalidOperationError);
    },
  );

  test("rejects a negative attempt and an out-of-range random", () => {
    expect(() => backoff.delayFor(-1, () => 0)).toThrow(InvalidOperationError);
    expect(() => backoff.delayFor(0, () => 1)).toThrow(InvalidOperationError);
    expect(() => backoff.delayFor(0, () => Number.NaN)).toThrow(InvalidOperationError);
  });
});
