import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import type { DatabaseConfig } from "../../src/infrastructure/config/env.ts";
import {
  MIGRATIONS_PATH,
  buildOrmOptions,
} from "../../src/infrastructure/persistence/mikro-orm.config.ts";
import { testDatabaseConfig, testInfra } from "./test-env.ts";

/**
 * Isolation strategy: one database per test suite, cloned from a migrated template.
 *
 * - The template name is content-addressed (hash of the migration files), so a schema
 *   change produces a new template instead of reusing a stale one.
 * - Creating/migrating the template and every CREATE DATABASE ... TEMPLATE run under the
 *   same advisory lock, so parallel test processes never clone while someone is still
 *   connected to the template.
 * - TRUNCATE is never used for cleanup: the ledger forbids it by trigger (Phase 2).
 */

const ADVISORY_LOCK_KEY = 7_340_001;
const SQLSTATE_OBJECT_IN_USE = "55006";

export class TemplateInUseError extends Error {
  override readonly name = "TemplateInUseError";
}

export interface IsolatedDatabase {
  readonly name: string;
  readonly config: DatabaseConfig;
  drop(): Promise<void>;
}

function adminConnection(database = "postgres", max = 1): SQL {
  return new SQL({
    hostname: testInfra.dbHost,
    port: testInfra.dbPort,
    username: testInfra.dbUser,
    password: testInfra.dbPassword,
    database,
    max,
  });
}

function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Unsafe database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  for (const key of ["errno", "code", "sqlState"] as const) {
    const value: unknown = (error as Record<string, unknown>)[key];
    if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) return value;
  }
  return undefined;
}

function migrationsFingerprint(): string {
  const hash = createHash("sha256");
  const files = readdirSync(MIGRATIONS_PATH)
    .filter((file) => file.endsWith(".ts"))
    .sort();
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(MIGRATIONS_PATH, file)));
  }
  return hash.digest("hex").slice(0, 12);
}

export const TEMPLATE_DATABASE = `wws_tpl_${migrationsFingerprint()}`;

async function withAdvisoryLock<T>(admin: SQL, fn: () => Promise<T>): Promise<T> {
  await admin.unsafe(`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
  try {
    return await fn();
  } finally {
    await admin.unsafe(`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
  }
}

async function templateIsReady(admin: SQL): Promise<boolean> {
  const rows: { ready: boolean }[] = await admin.unsafe(
    `select coalesce(shobj_description(oid, 'pg_database') = 'ready', false) as ready
       from pg_database where datname = $1`,
    [TEMPLATE_DATABASE],
  );
  return rows[0]?.ready === true;
}

/** Must be called with the advisory lock held. */
async function ensureTemplate(admin: SQL): Promise<void> {
  if (await templateIsReady(admin)) return;
  const template = quoteIdent(TEMPLATE_DATABASE);
  // A previous run may have died half-way: start from scratch.
  await admin.unsafe(`drop database if exists ${template} with (force)`);
  await admin.unsafe(`create database ${template}`);

  const orm = await MikroORM.init(buildOrmOptions(testDatabaseConfig(TEMPLATE_DATABASE)));
  try {
    await orm.migrator.up();
  } finally {
    // The migration pool MUST be fully closed before anyone clones the template,
    // otherwise CREATE DATABASE ... TEMPLATE fails with 55006.
    await orm.close(true);
  }
  await admin.unsafe(`comment on database ${template} is 'ready'`);
}

async function describeTemplateSessions(admin: SQL, template: string): Promise<string> {
  const rows: {
    pid: number;
    application_name: string;
    client_addr: string | null;
    state: string | null;
  }[] = await admin.unsafe(
    `select pid, application_name, client_addr::text as client_addr, state
         from pg_stat_activity where datname = $1`,
    [template],
  );
  if (rows.length === 0)
    return "nenhuma sessão visível agora (a conexão pode ter fechado logo após o erro)";
  return rows
    .map(
      (r) =>
        `pid=${r.pid} app=${r.application_name || "-"} addr=${r.client_addr ?? "local"} state=${r.state ?? "-"}`,
    )
    .join("; ");
}

/** Clones `template` into `name`, translating "template in use" into an actionable error. */
export async function cloneDatabase(admin: SQL, template: string, name: string): Promise<void> {
  try {
    await admin.unsafe(`create database ${quoteIdent(name)} template ${quoteIdent(template)}`);
  } catch (error) {
    if (sqlStateOf(error) !== SQLSTATE_OBJECT_IN_USE) throw error;
    const sessions = await describeTemplateSessions(admin, template);
    throw new TemplateInUseError(
      `Não foi possível criar "${name}" a partir do template "${template}": ` +
        `o template está em uso (SQLSTATE 55006). Sessões conectadas: ${sessions}. ` +
        `Causa provável: alguma conexão (pool do MikroORM, psql, IDE) continua aberta no template. ` +
        `Feche-a (orm.close(true)) antes de clonar.`,
      { cause: error },
    );
  }
}

export async function createIsolatedDatabase(
  suite: string,
  overrides: Partial<DatabaseConfig> = {},
): Promise<IsolatedDatabase> {
  const slug = suite
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 30);
  const name = `wws_${slug}_${Bun.randomUUIDv7().replaceAll("-", "").slice(-12)}`;
  const admin = adminConnection();
  try {
    await withAdvisoryLock(admin, async () => {
      await ensureTemplate(admin);
      await cloneDatabase(admin, TEMPLATE_DATABASE, name);
    });
  } finally {
    await admin.close();
  }
  return {
    name,
    config: testDatabaseConfig(name, overrides),
    drop: () => dropDatabase(name),
  };
}

export async function dropDatabase(name: string): Promise<void> {
  const admin = adminConnection();
  try {
    await admin.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
  } finally {
    await admin.close();
  }
}

/** Runs `fn` while holding the template lock (for tests that deliberately touch the template). */
export async function withTemplateLock<T>(fn: (admin: SQL) => Promise<T>): Promise<T> {
  const admin = adminConnection();
  try {
    return await withAdvisoryLock(admin, async () => {
      await ensureTemplate(admin);
      return fn(admin);
    });
  } finally {
    await admin.close();
  }
}

/** Short-lived admin/inspection connection to an arbitrary database of the test stack. */
export function openSql(database: string, max = 1): SQL {
  return adminConnection(database, max);
}
