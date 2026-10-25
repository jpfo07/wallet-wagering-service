import type { Clock, IdGenerator, RandomSource, Sleeper } from "../../application/ports/system.ts";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: time-ordered, so ids (and the outbox) sort by creation within a process. */
export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

export class MathRandomSource implements RandomSource {
  next(): number {
    return Math.random();
  }
}

export class TimerSleeper implements Sleeper {
  sleep(ms: number): Promise<void> {
    return Bun.sleep(ms);
  }
}
