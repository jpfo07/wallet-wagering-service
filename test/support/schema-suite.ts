import { afterAll, beforeAll } from "bun:test";
import type { SQL } from "bun";
import { createIsolatedDatabase, openSql } from "./database.ts";
import type { IsolatedDatabase } from "./database.ts";
import { SqlFixtures } from "./sql-fixtures.ts";

export interface SchemaSuite {
  readonly db: IsolatedDatabase;
  readonly sql: SQL;
  readonly fx: SqlFixtures;
}

/** One migrated database per suite, plus a raw SQL connection and fixtures bound to it. */
export function useSchemaSuite(name: string): () => SchemaSuite {
  let suite: SchemaSuite | undefined;
  beforeAll(async () => {
    const db = await createIsolatedDatabase(name);
    const sql = openSql(db.name, 4);
    suite = { db, sql, fx: new SqlFixtures(sql) };
  });
  afterAll(async () => {
    await suite?.sql.close();
    await suite?.db.drop();
  });
  return () => {
    if (suite === undefined) throw new Error("schema suite not initialized");
    return suite;
  };
}
