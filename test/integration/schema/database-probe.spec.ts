import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  DatabaseProbe,
  DatabaseProbeClosedError,
} from "../../../src/infrastructure/persistence/database-probe.ts";
import { buildOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm.config.ts";
import { createIsolatedDatabase } from "../../support/database.ts";
import type { IsolatedDatabase } from "../../support/database.ts";
import { testDatabaseConfig } from "../../support/test-env.ts";

const CLOSE_BUDGET_MS = 4_000;

/** Same call as the Nest MikroORM module on shutdown (not forced). */
const closeWithin = (orm: MikroORM): Promise<"closed" | "hung"> =>
  Promise.race([
    orm.close().then(() => "closed" as const),
    Bun.sleep(CLOSE_BUDGET_MS).then(() => "hung" as const),
  ]);

/**
 * Regression of the flaky worker shutdown: closing the pool while its first connection is still
 * being acquired hung the ORM close forever. A probe fired right before shutdown is that case.
 */
describe("DatabaseProbe and shutdown (real PostgreSQL)", () => {
  let db: IsolatedDatabase;

  beforeAll(async () => {
    db = await createIsolatedDatabase("database-probe");
  });

  afterAll(async () => {
    await db.drop();
  });

  test("a probe in flight on a fresh pool is awaited before the ORM closes, so the close ends", async () => {
    // The yield lets the pool start opening its first connection; the hang needs the close to land
    // while that connection is being established.
    for (const yieldMs of [0, 1, 2, 5]) {
      const orm = await MikroORM.init(buildOrmOptions(testDatabaseConfig(db.name)));
      const probe = new DatabaseProbe(orm);
      const ping = probe.ping();
      await Bun.sleep(yieldMs);
      await probe.beforeApplicationShutdown();
      expect(await closeWithin(orm)).toBe("closed");
      expect(probe.pending).toBe(0);
      expect(await ping).toBeDefined();
    }
  });

  test("after shutdown began, new probes are refused at once (readiness answers 503)", async () => {
    const orm = await MikroORM.init(buildOrmOptions(testDatabaseConfig(db.name)));
    const probe = new DatabaseProbe(orm);
    await probe.ping();
    await probe.beforeApplicationShutdown();
    const refused = await probe.ping().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(DatabaseProbeClosedError);
    expect(await closeWithin(orm)).toBe("closed");
  });
});
