import type { RandomSource } from "../../application/ports/system.ts";
import type { Logger } from "../../application/ports/telemetry.ts";
import type { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import { abortableSleep } from "../messaging/abortable-sleep.ts";

/** One cycle of a worker. Resolves true when it made progress, so the next cycle starts at once. */
export type PollingTask = (signal: AbortSignal) => Promise<boolean>;

export interface PollingLoopOptions {
  readonly name: string;
  readonly pollIntervalMs: number;
  /** Pause after a failed cycle (database or SQS down), growing while the failures last. */
  readonly errorBackoff: ExponentialBackoff;
}

/** Highest backoff exponent used: past it the delay is already at its ceiling. */
const MAX_BACKOFF_EXPONENT = 20;

/**
 * Runs `task` until stopped: right away again after a productive cycle, after `pollIntervalMs`
 * after an idle one, with backoff after a failure (and never gives up). `stop()` aborts the
 * signal (which wakes any pause and is checked by the task between units of work) and waits for
 * the cycle in progress to finish.
 */
export class PollingLoop {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly task: PollingTask,
    private readonly options: PollingLoopOptions,
    private readonly random: RandomSource,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running !== undefined) return;
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  private async loop(): Promise<void> {
    const { signal } = this.controller;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const progressed = await this.task(signal);
        failures = 0;
        if (!progressed) await abortableSleep(this.options.pollIntervalMs, signal);
      } catch (error) {
        const delayMs = this.options.errorBackoff.delayFor(
          Math.min(failures, MAX_BACKOFF_EXPONENT),
          () => this.random.next(),
        );
        failures += 1;
        this.logger.warn(`${this.options.name}: cycle failed, pausing`, {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          failures,
          delayMs,
        });
        await abortableSleep(delayMs, signal);
      }
    }
  }
}
