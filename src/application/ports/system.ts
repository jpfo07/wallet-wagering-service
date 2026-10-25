/** Wall-clock time. The domain never reads the clock: it receives dates from here. */
export interface Clock {
  now(): Date;
}

/** Ids for every new record (UUIDv7 in production, so ids sort by creation time). */
export interface IdGenerator {
  next(): string;
}

/** Uniform random number in [0, 1); used only for backoff jitter. */
export interface RandomSource {
  next(): number;
}

/** Waits between retries (fake in unit tests, so they never sleep). */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}
