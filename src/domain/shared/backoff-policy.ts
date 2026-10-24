import { InvalidOperationError } from "./domain-error.ts";

/**
 * Exponential backoff with "equal jitter": half of the delay is fixed and half is random, so
 * replicas retrying the same thing do not wake up together, while the delay still grows.
 * `random` is injected (returns [0, 1)) to keep the domain deterministic in tests.
 */
export class ExponentialBackoff {
  private constructor(
    readonly baseMs: number,
    readonly maxMs: number,
  ) {
    Object.freeze(this);
  }

  static of(props: { baseMs: number; maxMs: number }): ExponentialBackoff {
    const { baseMs, maxMs } = props;
    if (!Number.isInteger(baseMs) || !Number.isInteger(maxMs) || baseMs <= 0 || maxMs < baseMs) {
      throw new InvalidOperationError("backoff requires integers with 0 < baseMs <= maxMs");
    }
    return new ExponentialBackoff(baseMs, maxMs);
  }

  /** Delay before retry number `attempt` (0-based): ~base, ~2·base, ~4·base… capped at maxMs. */
  delayFor(attempt: number, random: () => number): number {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new InvalidOperationError("attempt must be a non-negative integer");
    }
    const r = random();
    if (!(r >= 0 && r < 1)) {
      throw new InvalidOperationError("random() must return a value in [0, 1)");
    }
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** attempt);
    const half = ceiling / 2;
    return Math.round(half + half * r);
  }
}

export function addMilliseconds(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}
