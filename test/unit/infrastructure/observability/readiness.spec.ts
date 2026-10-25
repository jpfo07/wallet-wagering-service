import { describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { createMetricsRegistry } from "../../../../src/infrastructure/observability/prometheus-metrics.ts";
import { checkReadiness } from "../../../../src/infrastructure/observability/readiness.ts";
import { startWorkerHealthServer } from "../../../../src/infrastructure/observability/worker-health-server.ts";

const sqsThat = (up: boolean): SQSClient =>
  ({
    send: () =>
      up ? Promise.resolve({ QueueUrl: "http://q" }) : Promise.reject(new Error("down")),
  }) as unknown as SQSClient;

const pg = (up: boolean) => () => (up ? Promise.resolve() : Promise.reject(new Error("down")));

describe("readiness", () => {
  test.each([
    [true, true, true, "up", "up"],
    [false, true, false, "down", "up"],
    [true, false, false, "up", "down"],
  ] as const)("postgres up=%p, sqs up=%p → ready=%p", async (pgUp, sqsUp, ready, postgres, sqs) => {
    expect(
      await checkReadiness({ pingPostgres: pg(pgUp), sqs: sqsThat(sqsUp), queueName: "q" }),
    ).toEqual({ ready, checks: { postgres, sqs } });
  });

  test("worker health server: 503 when not ready, live stays 200, /metrics exposes the registry", async () => {
    let started = false;
    const server = startWorkerHealthServer({
      isStarted: () => started,
      port: 0,
      processName: "outbox-publisher",
      instanceId: "w-1",
      metrics: createMetricsRegistry({
        process: "outbox-publisher",
        instanceId: "w-1",
        defaultMetrics: false,
      }),
      readiness: () =>
        checkReadiness({ pingPostgres: pg(false), sqs: sqsThat(true), queueName: "q" }),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      // The loop has not started yet: not ready, whatever the dependencies say.
      const starting = await fetch(`${base}/health/ready`);
      expect(starting.status).toBe(503);
      expect(await starting.json()).toEqual({ status: "starting" });
      started = true;
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: "unavailable",
        checks: { postgres: "down", sqs: "up" },
      });
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
    } finally {
      await server.stop();
    }
  });
});
