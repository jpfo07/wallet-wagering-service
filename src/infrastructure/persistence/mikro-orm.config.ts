import { fileURLToPath } from "node:url";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import type { Options } from "@mikro-orm/postgresql";
import type { DatabaseConfig } from "../config/env.ts";
import { PERSISTENCE_MODELS } from "./models/index.ts";

export const MIGRATIONS_PATH = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * Single source of truth for the ORM configuration, shared by the Nest module,
 * the migration entrypoint and the tests.
 *
 * lock_timeout / statement_timeout are passed as startup options of every pooled
 * connection, so a blocked `SELECT ... FOR UPDATE` fails fast with SQLSTATE 55P03
 * instead of hanging the request.
 */
export function buildOrmOptions(db: DatabaseConfig, overrides: Partial<Options> = {}): Options {
  return defineConfig({
    host: db.host,
    port: db.port,
    dbName: db.name,
    user: db.user,
    password: db.password,
    pool: { min: 0, max: db.poolMax },
    driverOptions: {
      options: `-c lock_timeout=${db.lockTimeoutMs} -c statement_timeout=${db.statementTimeoutMs}`,
    },
    entities: [...PERSISTENCE_MODELS],
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_PATH,
      pathTs: MIGRATIONS_PATH,
      glob: "!(*.d).ts",
      emit: "ts",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    allowGlobalContext: false,
    debug: false,
    ...overrides,
  });
}
