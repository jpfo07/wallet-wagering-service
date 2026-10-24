import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";

export type CheckResult = "up" | "down";

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: { readonly postgres: CheckResult; readonly sqs: CheckResult };
}

export interface ReadinessProbes {
  /** Any cheap round-trip to PostgreSQL (e.g. `select 1`). */
  readonly pingPostgres: () => Promise<unknown>;
  readonly sqs: SQSClient;
  readonly queueName: string;
}

async function probe(check: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await check();
    return "up";
  } catch {
    return "down";
  }
}

/** Readiness shared by the API and the workers: PostgreSQL and SQS must be reachable. */
export async function checkReadiness(probes: ReadinessProbes): Promise<ReadinessReport> {
  const [postgres, sqs] = await Promise.all([
    probe(probes.pingPostgres),
    probe(() => probes.sqs.send(new GetQueueUrlCommand({ QueueName: probes.queueName }))),
  ]);
  return { ready: postgres === "up" && sqs === "up", checks: { postgres, sqs } };
}
