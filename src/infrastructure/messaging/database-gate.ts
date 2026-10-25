import type { Clock, RandomSource } from "../../application/ports/system.ts";
import type { Logger } from "../../application/ports/telemetry.ts";
import type { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import { abortableSleep } from "./abortable-sleep.ts";

export interface DatabaseGateOptions {
  /** A probe slower than this counts as "down": a paused or partitioned server hangs, not fails. */
  readonly probeTimeoutMs: number;
  /** A healthy check younger than this lets the consumer fetch without probing again. */
  readonly freshnessMs: number;
  /** Pause between probes while the database is down. */
  readonly backoff: ExponentialBackoff;
}

/**
 * Keeps the consumer from fetching messages while PostgreSQL is unreachable. Each received message
 * counts towards maxReceiveCount, so fetching during an outage would push perfectly valid messages
 * into the DLQ. Messages already in flight follow the normal retry rule; only new fetches stop.
 *
 * Closed by a connection-class failure reported by the consumer or by a failed probe; opened again
 * only by a probe (or a processed message) that reached the database.
 */
export class DatabaseGate {
  private open = true;
  private lastHealthyAt = Number.NEGATIVE_INFINITY;
  /** At most one probe at a time: on a hung server, probes would pile up on the pool. */
  private probing: Promise<boolean> | undefined;
  private failedProbes = 0;

  constructor(
    private readonly probe: () => Promise<unknown>,
    private readonly options: DatabaseGateOptions,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly logger: Logger,
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  /** Probes that failed since the gate last closed (diagnostics and tests). */
  get failedProbeCount(): number {
    return this.failedProbes;
  }

  /** The database answered (a message was processed or acknowledged after reaching it). */
  markHealthy(): void {
    this.lastHealthyAt = this.clock.now().getTime();
    if (!this.open) {
      this.open = true;
      this.logger.info("database reachable again, resuming receive");
    }
  }

  markUnavailable(reason: string): void {
    if (this.open) {
      this.open = false;
      this.failedProbes = 0;
      this.logger.warn("database unreachable, pausing receive", { reason });
    }
  }

  /**
   * Resolves true when the consumer may fetch, or false if `signal` aborted first. While the
   * database is down it probes with exponential backoff, without limit: waiting costs nothing,
   * fetching costs receives.
   */
  async awaitAvailable(signal: AbortSignal): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) return false;
      const fresh = this.clock.now().getTime() - this.lastHealthyAt < this.options.freshnessMs;
      if (this.open && fresh) return true;
      if (await this.check(signal)) {
        this.markHealthy();
        return true;
      }
      if (isAborted(signal)) return false;
      this.markUnavailable("probe failed");
      this.failedProbes += 1;
      await abortableSleep(
        this.options.backoff.delayFor(Math.min(attempt, 30), () => this.random.next()),
        signal,
      );
    }
  }

  private async check(signal: AbortSignal): Promise<boolean> {
    this.probing ??= this.probe().then(
      () => true,
      () => false,
    );
    const probing = this.probing;
    void probing.finally(() => {
      if (this.probing === probing) this.probing = undefined;
    });
    // The timeout timer is cancelled as soon as the probe settles (or the consumer stops).
    const timer = new AbortController();
    const stop = (): void => {
      timer.abort();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const timedOut = abortableSleep(this.options.probeTimeoutMs, timer.signal).then(() => false);
      return await Promise.race([probing, timedOut]);
    } finally {
      stop();
      signal.removeEventListener("abort", stop);
    }
  }
}

/** Read through a call: `signal.aborted` flips during awaits, which narrowing does not see. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
