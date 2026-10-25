import { describe, expect, test } from "bun:test";
import type { Clock } from "../../../../src/application/ports/system.ts";
import { ExponentialBackoff } from "../../../../src/domain/shared/backoff-policy.ts";
import { DatabaseGate } from "../../../../src/infrastructure/messaging/database-gate.ts";
import { SilentLogger } from "../../../support/in-memory-telemetry.ts";
import { waitFor } from "../../../support/polling.ts";

class ManualClock implements Clock {
  constructor(private ms = 1_000_000) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

const options = {
  probeTimeoutMs: 50,
  freshnessMs: 1_000,
  backoff: ExponentialBackoff.of({ baseMs: 1, maxMs: 4 }),
};

function gate(probe: () => Promise<unknown>, clock = new ManualClock()) {
  return new DatabaseGate(probe, options, clock, { next: () => 0 }, new SilentLogger());
}

describe("DatabaseGate", () => {
  test("probes once, then lets fetches through while the check is fresh", async () => {
    let probes = 0;
    const clock = new ManualClock();
    const subject = gate(() => {
      probes += 1;
      return Promise.resolve();
    }, clock);
    const signal = new AbortController().signal;
    expect(await subject.awaitAvailable(signal)).toBe(true);
    expect(await subject.awaitAvailable(signal)).toBe(true);
    expect(probes).toBe(1);
    clock.advance(1_000);
    expect(await subject.awaitAvailable(signal)).toBe(true);
    expect(probes).toBe(2);
  });

  test("closed by a connection failure: waits until a probe reaches the database", async () => {
    let up = false;
    let probes = 0;
    const subject = gate(() => {
      probes += 1;
      if (probes === 3) up = true;
      return up ? Promise.resolve() : Promise.reject(new Error("ECONNREFUSED"));
    });
    subject.markHealthy();
    subject.markUnavailable("ECONNREFUSED");
    expect(subject.isOpen).toBe(false);
    expect(await subject.awaitAvailable(new AbortController().signal)).toBe(true);
    expect(subject.isOpen).toBe(true);
    expect(probes).toBe(3);
  });

  test("a hung probe counts as down, and is not duplicated while it hangs", async () => {
    let probes = 0;
    let finish!: () => void;
    const hung = new Promise<void>((resolve) => (finish = resolve));
    const subject = gate(() => {
      probes += 1;
      return hung;
    });
    const controller = new AbortController();
    const waiting = subject.awaitAvailable(controller.signal);
    await waitFor(() => subject.failedProbeCount >= 3, { description: "3 timed-out probes" });
    expect(subject.isOpen).toBe(false);
    expect(probes).toBe(1);
    finish();
    expect(await waiting).toBe(true);
    expect(subject.isOpen).toBe(true);
  });

  test("abort ends the wait with false", async () => {
    const subject = gate(() => Promise.reject(new Error("down")));
    const controller = new AbortController();
    const waiting = subject.awaitAvailable(controller.signal);
    await waitFor(() => !subject.isOpen, { description: "gate to close" });
    controller.abort();
    expect(await waiting).toBe(false);
  });
});
