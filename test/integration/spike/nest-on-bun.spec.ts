import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import { APP_CONFIG } from "../../../src/infrastructure/config/config.module.ts";
import type { AppConfig } from "../../../src/infrastructure/config/env.ts";
import { ApiModule } from "../../../src/infrastructure/http/api.module.ts";
import { HealthController } from "../../../src/infrastructure/http/health.controller.ts";
import { createIsolatedDatabase } from "../../support/database.ts";
import type { IsolatedDatabase } from "../../support/database.ts";
import {
  TEST_PENDING_REFERENCE,
  TEST_SQS_CONSUMER,
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
        workerHealthPort: 0,
        database: db.config,
        sqs: testSqsConfig(),
        transientRetry: TEST_TRANSIENT_RETRY,
        pendingReference: TEST_PENDING_REFERENCE,
        sqsConsumer: TEST_SQS_CONSUMER,
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
      // HealthController injects MikroORM by type, imported from a package.
      const paramTypes: unknown = Reflect.getMetadata("design:paramtypes", HealthController);
      expect(Array.isArray(paramTypes) && paramTypes[0] === MikroORM).toBe(true);

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
          await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health/live`)).ok, {
            timeoutMs: 20_000,
            description: `${worker} to become live`,
          });
          const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
          expect(ready.status).toBe(200);
          expect(await ready.json()).toEqual({
            status: "ok",
            checks: { postgres: "up", sqs: "up" },
          });

          child.kill("SIGTERM");
          const exitCode = await Promise.race([
            child.exited,
            Bun.sleep(15_000).then(() => "timeout" as const),
          ]);
          expect(exitCode).toBe(0);
          expect(await new Response(child.stdout).text()).toContain("shutdown complete");
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      });
    }

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
