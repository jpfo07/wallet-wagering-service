import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import { APP_CONFIG } from "../../../src/infrastructure/config/config.module.ts";
import type { AppConfig } from "../../../src/infrastructure/config/env.ts";
import { ApiModule } from "../../../src/infrastructure/http/api.module.ts";
import { HealthController } from "../../../src/infrastructure/http/health.controller.ts";
import { DatabaseProbe } from "../../../src/infrastructure/persistence/database-probe.ts";
import { createIsolatedDatabase } from "../../support/database.ts";
import type { IsolatedDatabase } from "../../support/database.ts";
import {
  TEST_PENDING_REFERENCE,
  TEST_SQS_CONSUMER,
  TEST_OUTBOX_PUBLISHER,
  TEST_PENDING_REFERENCE_WORKER,
  TEST_TRANSIENT_RETRY,
  childProcessEnv,
  testSqsConfig,
} from "../../support/test-env.ts";
import { waitFor } from "../../support/polling.ts";
import { GreetingController, GreetingModule } from "./fixtures/greeting.controller.ts";
import { ClockService, GreetingService } from "./fixtures/greeting.service.ts";

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);
  if (port === undefined) throw new Error("could not allocate a port");
  return port;
}

describe("spike A — NestJS on Bun", () => {
  test("A1: emitDecoratorMetadata keeps constructor types across modules (DI by type)", async () => {
    expect(Reflect.getMetadata("design:paramtypes", GreetingController)).toEqual([GreetingService]);
    expect(Reflect.getMetadata("design:paramtypes", GreetingService)).toEqual([ClockService]);

    const moduleRef = await Test.createTestingModule({ imports: [GreetingModule] }).compile();
    const controller = moduleRef.get(GreetingController);
    expect(controller.greet("bun")).toEqual({ message: "hello bun at 2026-01-01T00:00:00.000Z" });
    await moduleRef.close();
  });

  describe("with the real ApiModule (PostgreSQL + LocalStack)", () => {
    let db: IsolatedDatabase;
    let app: INestApplication;
    let baseUrl: string;

    beforeAll(async () => {
      db = await createIsolatedDatabase("spike-nest");
      const config: AppConfig = {
        instanceId: "spike-instance",
        httpPort: 0,
        httpRetryAfterSeconds: 1,
        httpShutdownDrainMs: 0,
        workerHealthPort: 0,
        database: db.config,
        sqs: testSqsConfig(),
        transientRetry: TEST_TRANSIENT_RETRY,
        pendingReference: TEST_PENDING_REFERENCE,
        sqsConsumer: TEST_SQS_CONSUMER,
        outboxPublisher: TEST_OUTBOX_PUBLISHER,
        pendingReferenceWorker: TEST_PENDING_REFERENCE_WORKER,
      };
      const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
        .overrideProvider(APP_CONFIG)
        .useValue(config)
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      await app.listen(0, "127.0.0.1");
      baseUrl = await app.getUrl();
    });

    afterAll(async () => {
      await app.close();
      await db.drop();
    });

    test("A2: bun test boots a Nest module and serves real HTTP", async () => {
      // Injection by type: HealthController → DatabaseProbe (local class) → MikroORM (package).
      const paramTypes: unknown = Reflect.getMetadata("design:paramtypes", HealthController);
      expect(Array.isArray(paramTypes) && paramTypes[0] === DatabaseProbe).toBe(true);
      const probeTypes: unknown = Reflect.getMetadata("design:paramtypes", DatabaseProbe);
      expect(Array.isArray(probeTypes) && probeTypes[0] === MikroORM).toBe(true);

      const live = await fetch(`${baseUrl}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok", instanceId: "spike-instance" });

      const ready = await fetch(`${baseUrl}/health/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
    });
  });

  describe("process lifecycle", () => {
    let db: IsolatedDatabase;
    beforeAll(async () => {
      db = await createIsolatedDatabase("spike-shutdown");
    });
    afterAll(async () => {
      await db.drop();
    });

    test("A3: the API entrypoint exits 0 on SIGTERM after running Nest shutdown hooks", async () => {
      const port = freePort();
      const child = Bun.spawn(["bun", "run", "src/entrypoints/api.ts"], {
        cwd: new URL("../../../", import.meta.url).pathname,
        env: childProcessEnv(db.config, { HTTP_PORT: String(port), INSTANCE_ID: "spike-child" }),
        stdout: "pipe",
        stderr: "pipe",
      });
      const spawnedAt = performance.now();
      try {
        await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health/live`)).ok, {
          timeoutMs: 20_000,
          intervalMs: 20,
          description: "api child to become live",
        });
        // Read by scripts/bun-compat-matrix.sh.
        console.log(`[metric] api_boot_ms=${Math.round(performance.now() - spawnedAt)}`);
        child.kill("SIGTERM");
        const exitCode = await Promise.race([
          child.exited,
          Bun.sleep(15_000).then(() => "timeout" as const),
        ]);
        const stdout = await new Response(child.stdout).text();
        expect(exitCode).toBe(0);
        expect(stdout).toContain("shutdown complete");
        // Nest's own boot messages included: every line is JSON of the process logger.
        const lines = stdout.trim().split("\n");
        expect(lines.some((line) => line.includes("RouterExplorer"))).toBe(true);
        for (const line of lines) expect(JSON.parse(line)).toMatchObject({ process: "api" });
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    });

    for (const worker of ["sqs-consumer", "outbox-publisher", "pending-reference-worker"]) {
      test(`A3b: ${worker} entrypoint is healthy and exits 0 on SIGTERM`, async () => {
        const port = freePort();
        const child = Bun.spawn(["bun", "run", `src/entrypoints/${worker}.ts`], {
          cwd: new URL("../../../", import.meta.url).pathname,
          env: childProcessEnv(db.config, {
            WORKER_HEALTH_PORT: String(port),
            INSTANCE_ID: `spike-${worker}`,
          }),
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          // Live comes up before the loop has started; ready only once it runs.
          const ready = await waitFor(
            async () => {
              const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
              return response.status === 200 ? await response.json() : undefined;
            },
            { timeoutMs: 20_000, description: `${worker} to become ready` },
          );
          expect(ready).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
          const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
          expect(metrics.status).toBe(200);
          const exposition = await metrics.text();
          expect(exposition).toContain(`process="${worker}"`);
          expect(exposition).toContain("process_cpu_seconds_total");
          if (worker === "sqs-consumer") expect(exposition).toContain("wws_sqs_dlq_messages{");

          child.kill("SIGTERM");
          const exitCode = await Promise.race([
            child.exited,
            Bun.sleep(15_000).then(() => "timeout" as const),
          ]);
          const stdout = await new Response(child.stdout).text();
          const stderr = await new Response(child.stderr).text();
          // On failure the message carries the process output: it says which step went wrong.
          expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
          expect(stdout).toContain("shutdown complete");
          // Every line is one JSON object of the same shape (boot log and pino alike).
          for (const line of stdout.trim().split("\n")) {
            expect(JSON.parse(line)).toMatchObject({
              process: worker,
              instanceId: `spike-${worker}`,
            });
          }
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      });
    }

    // Regression (flaky A3b): a SIGTERM while the loop was still starting closed the ORM under a
    // probe that was opening the pool's first connection, and the close hung until the deadline
    // (exit 1). Now the shutdown waits for the start and for the probes in flight.
    test("A3d: sqs-consumer exits 0 on a SIGTERM sent as soon as it is live (loop still starting)", async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const port = freePort();
        const child = Bun.spawn(["bun", "run", "src/entrypoints/sqs-consumer.ts"], {
          cwd: new URL("../../../", import.meta.url).pathname,
          env: childProcessEnv(db.config, {
            WORKER_HEALTH_PORT: String(port),
            INSTANCE_ID: `spike-a3d-${attempt}`,
          }),
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health/live`)).ok, {
            timeoutMs: 20_000,
            intervalMs: 5,
            description: "sqs-consumer to become live",
          });
          child.kill("SIGTERM");
          const exitCode = await Promise.race([
            child.exited,
            Bun.sleep(15_000).then(() => "timeout" as const),
          ]);
          const stdout = await new Response(child.stdout).text();
          expect(exitCode, `stdout:\n${stdout}`).toBe(0);
          expect(stdout).toContain("shutdown complete");
          // A loop that managed to start is stopped, never left running under a closed app.
          if (stdout.includes("sqs consumer started"))
            expect(stdout).toContain("sqs consumer stopped");
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      }
    });

    // Regression: the handler used to be installed only after boot, so a SIGTERM during boot
    // was ignored by PID 1 in the container and the process was SIGKILLed (exit 137).
    for (const entrypoint of [
      "api",
      "sqs-consumer",
      "outbox-publisher",
      "pending-reference-worker",
    ]) {
      test(`A3c: ${entrypoint} exits 0 on a SIGTERM received during boot`, async () => {
        const child = Bun.spawn(["bun", "run", `src/entrypoints/${entrypoint}.ts`], {
          cwd: new URL("../../../", import.meta.url).pathname,
          env: childProcessEnv(db.config, {
            HTTP_PORT: String(freePort()),
            WORKER_HEALTH_PORT: String(freePort()),
            INSTANCE_ID: `spike-boot-${entrypoint}`,
          }),
          stdout: "pipe",
          stderr: "pipe",
        });
        let stdout = "";
        const drained = (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of child.stdout) stdout += decoder.decode(chunk, { stream: true });
        })();
        try {
          // "starting" is logged right after the handler is installed, before Nest is loaded.
          await waitFor(() => stdout.includes('"starting"'), {
            timeoutMs: 10_000,
            intervalMs: 5,
            description: `${entrypoint} to log "starting"`,
          });
          child.kill("SIGTERM");
          const exitCode = await Promise.race([
            child.exited,
            Bun.sleep(5_000).then(() => "timeout" as const),
          ]);
          expect(exitCode).toBe(0);
          await drained;
          expect(stdout).toContain("received SIGTERM");
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      });
    }
  });
});
