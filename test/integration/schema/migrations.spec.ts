import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import { buildOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm.config.ts";
import { PERSISTENCE_MODELS } from "../../../src/infrastructure/persistence/models/index.ts";
import { createIsolatedDatabase, openSql } from "../../support/database.ts";
import type { IsolatedDatabase } from "../../support/database.ts";
import { testDatabaseConfig } from "../../support/test-env.ts";

const APP_TABLES = [
  "inbox_messages",
  "outbox_messages",
  "wager_transactions",
  "wallet_ledger_entries",
  "wallets",
];

async function listObjects(sql: SQL): Promise<{ tables: string[]; functions: string[] }> {
  const tables: { name: string }[] = await sql.unsafe(
    `select tablename as name from pg_tables
      where schemaname = 'public' and tablename <> 'mikro_orm_migrations' order by 1`,
  );
  const functions: { name: string }[] = await sql.unsafe(
    `select proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and proname like 'wws\\_%' order by 1`,
  );
  return { tables: tables.map((t) => t.name), functions: functions.map((f) => f.name) };
}

describe("migrations", () => {
  let db: IsolatedDatabase;
  let orm: MikroORM;
  let sql: SQL;

  beforeAll(async () => {
    // Start from a migrated clone, then take it down to zero ourselves.
    db = await createIsolatedDatabase("schema-migrations");
    orm = await MikroORM.init(buildOrmOptions(testDatabaseConfig(db.name)));
    sql = openSql(db.name);
  });

  afterAll(async () => {
    await sql.close();
    await orm.close(true);
    await db.drop();
  });

  test("up → down (to zero) → up runs clean and down leaves nothing behind", async () => {
    expect((await listObjects(sql)).tables).toEqual(APP_TABLES);

    const reverted = await orm.migrator.down({ to: 0 });
    expect(reverted.map((m) => m.name)).toEqual([
      "Migration20261025000100_workers_schema",
      "Migration20261024000200_messaging_schema",
      "Migration20261024000100_financial_schema",
    ]);
    expect(await listObjects(sql)).toEqual({ tables: [], functions: [] });

    const applied = await orm.migrator.up();
    expect(applied.map((m) => m.name)).toEqual([
      "Migration20261024000100_financial_schema",
      "Migration20261024000200_messaging_schema",
      "Migration20261025000100_workers_schema",
    ]);
    const objects = await listObjects(sql);
    expect(objects.tables).toEqual(APP_TABLES);
    expect(objects.functions.length).toBeGreaterThan(0);
    expect(await orm.migrator.getPending()).toEqual([]);
  });

  test("every persistence model property maps to an existing column with the expected nullability", async () => {
    const columns: { table: string; column: string; nullable: boolean; type: string }[] =
      await sql.unsafe(
        `select table_name as table, column_name as column, is_nullable = 'YES' as nullable,
                data_type as type
           from information_schema.columns where table_schema = 'public'`,
      );
    const byKey = new Map(columns.map((c) => [`${c.table}.${c.column}`, c]));

    const metas = [...orm.getMetadata()].filter((meta) => APP_TABLES.includes(meta.tableName));
    expect(metas).toHaveLength(PERSISTENCE_MODELS.length);
    for (const meta of metas) {
      const props = meta.props.filter((prop) => prop.persist !== false);
      const tableColumns = columns.filter((c) => c.table === meta.tableName);
      expect(props.length).toBe(tableColumns.length);
      for (const prop of props) {
        const column = byKey.get(`${meta.tableName}.${prop.fieldNames[0] ?? ""}`);
        expect(column, `${meta.tableName}.${prop.name}`).toBeDefined();
        expect(column?.nullable, `${meta.tableName}.${prop.name} nullability`).toBe(
          prop.nullable === true,
        );
      }
    }
  });

  test("money columns are numeric(20,2) and timestamps keep millisecond precision", async () => {
    const money: { column: string; precision: number; scale: number }[] = await sql.unsafe(
      `select table_name || '.' || column_name as column, numeric_precision as precision,
              numeric_scale as scale
         from information_schema.columns
        where table_schema = 'public' and data_type = 'numeric' order by 1`,
    );
    expect(money.map((m) => m.column)).toEqual([
      "wager_transactions.amount",
      "wager_transactions.observed_balance_amount",
      "wallet_ledger_entries.amount",
      "wallet_ledger_entries.balance_after",
      "wallet_ledger_entries.balance_before",
      "wallets.balance",
    ]);
    for (const m of money) expect([m.precision, m.scale]).toEqual([20, 2]);

    const floats: unknown[] = await sql.unsafe(
      `select 1 from information_schema.columns
        where table_schema = 'public' and data_type in ('real', 'double precision', 'money')`,
    );
    expect(floats).toEqual([]);

    const timestamps: { precision: number }[] = await sql.unsafe(
      `select distinct datetime_precision as precision from information_schema.columns
        where table_schema = 'public' and data_type = 'timestamp with time zone'
          and table_name <> 'mikro_orm_migrations'`,
    );
    expect(timestamps).toEqual([{ precision: 3 }]);
  });
});
