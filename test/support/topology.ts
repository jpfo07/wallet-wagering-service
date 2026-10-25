import type { DatabaseConfig } from "../../src/infrastructure/config/env.ts";
import { waitFor } from "./polling.ts";
import { freePort, spawnScript } from "./processes.ts";
import type { ChildProcess } from "./processes.ts";
import type { IsolatedQueues } from "./queues.ts";
import { childProcessEnv } from "./test-env.ts";

export type ProcessKind = "api" | "sqs-consumer" | "outbox-publisher" | "pending-reference-worker";

export interface TopologyLayout {
  readonly apis: number;
  readonly consumers: number;
  readonly publishers: number;
  readonly pendingWorkers: number;
}

/** Full layout of the multi-instance tests; the reduced one if memory gets tight. */
export const FULL_LAYOUT: TopologyLayout = {
  apis: 3,
  consumers: 2,
  publishers: 1,
  pendingWorkers: 1,
};

/** Visibility of the isolated wager queue: covers the worst case of TOPOLOGY_ENV (~7 s). */
export const TOPOLOGY_VISIBILITY_TIMEOUT_SECONDS = 10;

/**
 * Short timings so a killed consumer's message comes back in seconds and a lock fight ends quickly;
 * small pools so seven processes fit in the test machine. The consumer checks at boot that the
 * visibility timeout covers its worst case: (2×3−1)×1000 + 2×(10+20) + 2000 ≈ 7.1 s < 10 s.
 */
const TOPOLOGY_ENV: Readonly<Record<string, string>> = {
  DATABASE_LOCK_TIMEOUT_MS: "1000",
  DATABASE_TRANSIENT_RETRY_ATTEMPTS: "3",
  DATABASE_TRANSIENT_RETRY_BASE_MS: "10",
  DATABASE_TRANSIENT_RETRY_MAX_MS: "40",
  SQS_PROCESSING_MARGIN_MS: "2000",
  SQS_WAIT_TIME_SECONDS: "1",
  SQS_RETRY_BACKOFF_BASE_MS: "200",
  SQS_RETRY_BACKOFF_MAX_MS: "1000",
  SQS_SHUTDOWN_DRAIN_MS: "3000",
  OUTBOX_POLL_INTERVAL_MS: "20",
  OUTBOX_RETRY_BACKOFF_BASE_MS: "100",
  OUTBOX_RETRY_BACKOFF_MAX_MS: "1000",
  PENDING_REFERENCE_POLL_INTERVAL_MS: "50",
  PENDING_REFERENCE_BACKOFF_BASE_MS: "200",
  PENDING_REFERENCE_BACKOFF_MAX_MS: "1000",
  HTTP_RETRY_AFTER_SECONDS: "1",
};

const SCRIPTS: Readonly<Record<ProcessKind, string>> = {
  api: "src/entrypoints/api.ts",
  "sqs-consumer": "src/entrypoints/sqs-consumer.ts",
  "outbox-publisher": "src/entrypoints/outbox-publisher.ts",
  "pending-reference-worker": "src/entrypoints/pending-reference-worker.ts",
};

interface Member {
  readonly name: string;
  readonly kind: ProcessKind;
  readonly port: number;
  process: ChildProcess | undefined;
}

/**
 * The service as separate Bun processes, as separate containers would run it: every process has
 * its own pool, SQS client and health port; only PostgreSQL and the queues are shared. Members keep
 * their port across restarts, so an API comes back at the same URL.
 */
export class Topology {
  private readonly members: Member[] = [];

  constructor(
    private readonly database: DatabaseConfig,
    private readonly queues: IsolatedQueues,
    layout: TopologyLayout = FULL_LAYOUT,
  ) {
    const add = (kind: ProcessKind, count: number): void => {
      for (let i = 1; i <= count; i += 1) {
        this.members.push({ name: `${kind}-${i}`, kind, port: freePort(), process: undefined });
      }
    };
    add("api", layout.apis);
    add("sqs-consumer", layout.consumers);
    add("outbox-publisher", layout.publishers);
    add("pending-reference-worker", layout.pendingWorkers);
  }

  /** Base URLs of the API members, in name order (api-1, api-2, ...). */
  get apiUrls(): readonly string[] {
    return this.members.filter((m) => m.kind === "api").map((m) => `http://127.0.0.1:${m.port}`);
  }

  get names(): readonly string[] {
    return this.members.map((m) => m.name);
  }

  /** Starts every member not running and waits until each one is ready. */
  async startAll(): Promise<void> {
    for (const member of this.members) {
      if (member.process === undefined) this.spawn(member);
    }
    await Promise.all(this.members.map((member) => this.waitReady(member)));
  }

  async start(name: string): Promise<void> {
    const member = this.member(name);
    if (member.process === undefined) this.spawn(member);
    await this.waitReady(member);
  }

  /** SIGKILL: a crash, nothing runs after it (no drain, no ack, no release). */
  kill(name: string): void {
    const member = this.member(name);
    member.process?.kill();
    member.process = undefined;
  }

  /** SIGTERM to every running member, in parallel; resolves with each exit code. */
  async stopAll(timeoutMs = 20_000): Promise<Record<string, number | "timeout">> {
    const running = this.members.filter((m) => m.process !== undefined);
    const codes = await Promise.all(
      running.map(async (member) => {
        const process = member.process;
        if (process === undefined) return [member.name, 0] as const;
        process.child.kill("SIGTERM");
        const code = await process.exited(timeoutMs);
        process.kill();
        member.process = undefined;
        return [member.name, code] as const;
      }),
    );
    return Object.fromEntries(codes);
  }

  /** Everything a member wrote to stdout (diagnostics on failure). */
  output(name: string): string {
    return this.member(name).process?.output() ?? "";
  }

  /** For `afterAll`: no process outlives the suite. */
  killAll(): void {
    for (const member of this.members) {
      member.process?.kill();
      member.process = undefined;
    }
  }

  private member(name: string): Member {
    const member = this.members.find((m) => m.name === name);
    if (member === undefined) throw new Error(`no member ${name}`);
    return member;
  }

  private spawn(member: Member): void {
    member.process = spawnScript(
      SCRIPTS[member.kind],
      childProcessEnv(this.database, {
        ...TOPOLOGY_ENV,
        INSTANCE_ID: member.name,
        DATABASE_POOL_MAX: String(this.database.poolMax),
        SQS_WAGER_QUEUE_NAME: this.queues.wagerQueueName,
        SQS_WAGER_DLQ_NAME: this.queues.dlqName,
        SQS_EVENTS_QUEUE_NAME: this.queues.eventsQueueName,
        ...(member.kind === "api"
          ? { HTTP_PORT: String(member.port) }
          : { WORKER_HEALTH_PORT: String(member.port) }),
      }),
    );
  }

  private async waitReady(member: Member): Promise<void> {
    await waitFor(
      async () => {
        if (member.process?.child.exitCode !== null) {
          throw new Error(`${member.name} exited during boot:\n${member.process?.output() ?? ""}`);
        }
        const response = await fetch(`http://127.0.0.1:${member.port}/health/ready`);
        return response.status === 200;
      },
      { timeoutMs: 40_000, intervalMs: 50, description: `${member.name} to become ready` },
    );
  }
}
