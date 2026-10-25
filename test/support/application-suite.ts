import { afterAll, beforeAll } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import type { Sleeper } from "../../src/application/ports/system.ts";
import { buildApplication } from "../../src/infrastructure/application/composition.ts";
import type {
  Application,
  ApplicationDependencies,
} from "../../src/infrastructure/application/composition.ts";
import type {
  DatabaseConfig,
  PendingReferenceConfig,
} from "../../src/infrastructure/config/env.ts";
import { InMemoryApplicationMetrics, SilentLogger } from "./in-memory-telemetry.ts";
import { buildOrmOptions } from "../../src/infrastructure/persistence/mikro-orm.config.ts";
import { createIsolatedDatabase, openSql } from "./database.ts";
import type { IsolatedDatabase } from "./database.ts";
import { TEST_PENDING_REFERENCE, TEST_TRANSIENT_RETRY } from "./test-env.ts";

/** Records requested delays instead of sleeping, so retry tests are fast and inspectable. */
export class RecordingSleeper implements Sleeper {
  readonly delays: number[] = [];

  sleep(ms: number): Promise<void> {
    this.delays.push(ms);
    return Promise.resolve();
  }
}

export interface AppHandle {
  readonly orm: MikroORM;
  readonly app: Application;
  readonly metrics: InMemoryApplicationMetrics;
  readonly sleeper: RecordingSleeper;
}

export interface ApplicationSuite extends AppHandle {
  readonly db: IsolatedDatabase;
  /** Raw connection for inspection and for holding locks from "another instance". */
  readonly sql: SQL;
  /**
   * Another application on the same database (its own pool), e.g. with a short lock_timeout or a
   * fault-injecting unit of work. Closed automatically at the end of the suite.
   */
  open(options?: {
    readonly database?: Partial<DatabaseConfig>;
    readonly dependencies?: (orm: MikroORM) => Partial<ApplicationDependencies>;
    readonly pendingReference?: PendingReferenceConfig;
  }): Promise<AppHandle>;
}

/**
 * One migrated database per suite (cloned from the template), the real ORM and the real use cases,
 * composed exactly like production (buildApplication), with a silent logger.
 */
export function useApplicationSuite(
  name: string,
  options: { readonly poolMax?: number; readonly sqlPoolMax?: number } = {},
): () => ApplicationSuite {
  let suite: ApplicationSuite | undefined;
  const opened: MikroORM[] = [];

  async function openHandle(
    db: IsolatedDatabase,
    database: Partial<DatabaseConfig> = {},
    dependencies?: (orm: MikroORM) => Partial<ApplicationDependencies>,
    pendingReference: PendingReferenceConfig = TEST_PENDING_REFERENCE,
  ): Promise<AppHandle> {
    const orm = await MikroORM.init(
      buildOrmOptions({ ...db.config, poolMax: options.poolMax ?? 10, ...database }),
    );
    opened.push(orm);
    const metrics = new InMemoryApplicationMetrics();
    const sleeper = new RecordingSleeper();
    const app = buildApplication(
      orm,
      {
        instanceId: "test",
        transientRetry: TEST_TRANSIENT_RETRY,
        pendingReference,
      },
      { logger: new SilentLogger(), metrics, sleeper, ...dependencies?.(orm) },
    );
    return { orm, app, metrics, sleeper };
  }

  beforeAll(async () => {
    const db = await createIsolatedDatabase(name);
    const sql = openSql(db.name, options.sqlPoolMax ?? 4);
    const main = await openHandle(db);
    suite = {
      ...main,
      db,
      sql,
      open: (openOptions = {}) =>
        openHandle(
          db,
          openOptions.database,
          openOptions.dependencies,
          openOptions.pendingReference,
        ),
    };
  });

  afterAll(async () => {
    for (const orm of opened) await orm.close(true);
    await suite?.sql.close();
    await suite?.db.drop();
  });

  return () => {
    if (suite === undefined) throw new Error("application suite not initialized");
    return suite;
  };
}
