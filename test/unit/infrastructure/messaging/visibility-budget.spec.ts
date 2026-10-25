import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../../../src/infrastructure/config/env.ts";
import {
  assertVisibilityBudget,
  worstCaseProcessingMs,
} from "../../../../src/infrastructure/messaging/visibility-budget.ts";

/** The production defaults (env.ts). */
const defaults = {
  transientRetry: { maxAttempts: 3, baseMs: 50, maxMs: 400 },
  lockTimeoutMs: 5_000,
  processingMarginMs: 10_000,
};

describe("worst-case processing time", () => {
  test("defaults: 5 lock timeouts + 2 × (50 + 100) ms of backoff + 10 s of margin", () => {
    expect(worstCaseProcessingMs(defaults)).toBe(25_000 + 300 + 10_000);
  });

  test("backoff ceilings are capped by maxMs", () => {
    const input = { ...defaults, transientRetry: { maxAttempts: 5, baseMs: 100, maxMs: 300 } };
    // retries: 100, 200, 300, 300 → 900 per cycle
    expect(worstCaseProcessingMs(input)).toBe(9 * 5_000 + 2 * 900 + 10_000);
  });

  test("a single attempt has no backoff", () => {
    const input = { ...defaults, transientRetry: { maxAttempts: 1, baseMs: 50, maxMs: 400 } };
    expect(worstCaseProcessingMs(input)).toBe(5_000 + 10_000);
  });
});

describe("assertVisibilityBudget", () => {
  test("60 s covers the defaults", () => {
    expect(() => {
      assertVisibilityBudget(60, defaults);
    }).not.toThrow();
  });

  test("the former 30 s does not, and the error says the minimum", () => {
    expect(() => {
      assertVisibilityBudget(30, defaults);
    }).toThrow(ConfigError);
    expect(() => {
      assertVisibilityBudget(30, defaults);
    }).toThrow("pelo menos 36 s");
  });

  test("exactly the worst case is not enough (strictly greater)", () => {
    const input = { ...defaults, processingMarginMs: 34_700 };
    expect(worstCaseProcessingMs(input)).toBe(60_000);
    expect(() => {
      assertVisibilityBudget(60, input);
    }).toThrow(ConfigError);
  });
});
