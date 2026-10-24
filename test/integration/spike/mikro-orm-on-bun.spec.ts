import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Controller, Get, Module, Param } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import {
  DeadlockException,
  EntityManager,
  LockMode,
  LockWaitTimeoutException,
  MikroORM,
  PostgreSqlDriver,
  RequestContext,
  defineEntity,
  p,
} from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import { buildOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm.config.ts";
import { createIsolatedDatabase, openSql, sqlStateOf } from "../../support/database.ts";
import type { IsolatedDatabase } from "../../support/database.ts";
import { waitFor } from "../../support/polling.ts";

const SpikeAccount = defineEntity({
  name: "SpikeAccount",
  tableName: "spike_accounts",
  properties: {
    id: p.uuid().primary(),
    balance: p.decimal("string").precision(20).scale(2),
    version: p.integer(),
  },
});

const CREATE_TABLE = `
  create table spike_accounts (
    id uuid primary key,
    balance numeric(20,2) not null check (balance >= 0),
    version integer not null
  )`;

describe("spike B — MikroORM 7 on Bun (real PostgreSQL)", () => {
  let db: IsolatedDatabase;
  let orm: MikroORM;
  let inspector: SQL;
  const capturedSql: string[] = [];

  beforeAll(async () => {
    db = await createIsolatedDatabase("spike-orm");
    orm = await MikroORM.init(
      buildOrmOptions(db.config, {
        entities: [SpikeAccount],
        debug: ["query"],
        logger: (message: string) => capturedSql.push(message),
      }),
    );
    await orm.em.getConnection().execute(CREATE_TABLE);
    inspector = openSql("postgres");
  });

  afterAll(async () => {
    await orm.close(true);
    await inspector.close();
    await db.drop();
  });

  async function insertAccount(balance: string): Promise<string> {
    const id = Bun.randomUUIDv7();
    const em = orm.em.fork();
    em.create(SpikeAccount, { id, balance, version: 1 });
    await em.flush();
    return id;
  }

  test("B5: numeric(20,2) round-trips as an exact string, never a number", async () => {
    const big = await insertAccount("12345678901234567.89");
    const small = await insertAccount("0.10");

    const em = orm.em.fork();
    const loadedBig = await em.findOneOrFail(SpikeAccount, big);
    const loadedSmall = await em.findOneOrFail(SpikeAccount, small);
    expect(typeof loadedBig.balance).toBe("string");
    expect(loadedBig.balance).toBe("12345678901234567.89");
    expect(loadedSmall.balance).toBe("0.10");

    const raw: { balance: unknown }[] = await em
      .getConnection()
      .execute("select balance from spike_accounts where id = ?", [big]);
    expect(raw[0]?.balance).toBe("12345678901234567.89");
  });

  test("B6: em.transactional + PESSIMISTIC_WRITE issues SELECT ... FOR UPDATE", async () => {
    const id = await insertAccount("100.00");
    capturedSql.length = 0;
    await orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(SpikeAccount, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    });
    const lockQuery = capturedSql.find((line) =>
      /select .*spike_accounts.* for update/i.test(line),
    );
    expect(lockQuery).toBeDefined();
  });

  test("B7: a second transaction really blocks on the row lock and sees the committed value", async () => {
    const id = await insertAccount("100.00");
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
    let signalLocked!: () => void;
    const aHasLock = new Promise<void>((resolve) => (signalLocked = resolve));

    const txA = orm.em.fork().transactional(async (em) => {
      const account = await em.findOneOrFail(SpikeAccount, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      signalLocked();
      await aMayCommit;
      account.balance = "20.00";
      account.version += 1;
    });
    await aHasLock;

    let bFinished = false;
    const txB = orm.em
      .fork()
      .transactional(async (em) => {
        const account = await em.findOneOrFail(SpikeAccount, id, {
          lockMode: LockMode.PESSIMISTIC_WRITE,
        });
        return { balance: account.balance, version: account.version };
      })
      .finally(() => (bFinished = true));

    await waitFor(
      async () => {
        const rows: { waiting: number }[] = await inspector.unsafe(
          `select count(*)::int as waiting from pg_stat_activity
            where datname = $1 and wait_event_type = 'Lock'`,
          [db.name],
        );
        return (rows[0]?.waiting ?? 0) >= 1;
      },
      { description: "transaction B waiting on the row lock" },
    );
    expect(bFinished).toBe(false);

    releaseA();
    await txA;
    expect(await txB).toEqual({ balance: "20.00", version: 2 });
  });

  test("B8: lock_timeout makes a blocked lock fail fast with SQLSTATE 55P03", async () => {
    const id = await insertAccount("100.00");
    const impatient = await MikroORM.init(
      buildOrmOptions({ ...db.config, lockTimeoutMs: 300 }, { entities: [SpikeAccount] }),
    );
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
    let signalLocked!: () => void;
    const aHasLock = new Promise<void>((resolve) => (signalLocked = resolve));
    const txA = orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(SpikeAccount, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      signalLocked();
      await aMayCommit;
    });
    try {
      await aHasLock;
      const setting: { lock_timeout: string }[] = await impatient.em
        .getConnection()
        .execute("show lock_timeout");
      expect(setting[0]?.lock_timeout).toBe("300ms");

      let caught: unknown;
      try {
        await impatient.em.fork().transactional(async (em) => {
          await em.findOneOrFail(SpikeAccount, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
        });
      } catch (error) {
        caught = error;
      }
      expect(sqlStateOf(caught)).toBe("55P03");
      // Finding: on PostgreSQL MikroORM does NOT map 55P03 to LockWaitTimeoutException
      // (only 40P01 -> DeadlockException). Transient-error classification must use SQLSTATE.
      expect(caught).not.toBeInstanceOf(LockWaitTimeoutException);
      expect(caught).not.toBeInstanceOf(DeadlockException);
    } finally {
      releaseA();
      await txA;
      await impatient.close(true);
    }
  });

  test("B9: programmatic migrator discovers .ts files and runs up/down", async () => {
    const dir = join(import.meta.dir, "..", "..", ".tmp", `migrations-${Bun.randomUUIDv7()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "Migration20260101000000_spike.ts"),
      `import { Migration } from "@mikro-orm/migrations";
export class Migration20260101000000_spike extends Migration {
  override up(): void { this.addSql("create table spike_migrated (id integer primary key)"); }
  override down(): void { this.addSql("drop table spike_migrated"); }
}
`,
    );
    const migrating = await MikroORM.init(
      buildOrmOptions(db.config, {
        migrations: {
          path: dir,
          pathTs: dir,
          glob: "!(*.d).ts",
          transactional: true,
          snapshot: false,
        },
      }),
    );
    try {
      const exists = async (): Promise<boolean> => {
        const rows: { exists: boolean }[] = await migrating.em
          .getConnection()
          .execute("select to_regclass('spike_migrated') is not null as exists");
        return rows[0]?.exists === true;
      };
      const applied = await migrating.migrator.up();
      expect(applied.map((m) => m.name)).toEqual(["Migration20260101000000_spike"]);
      expect(await exists()).toBe(true);

      const reverted = await migrating.migrator.down();
      expect(reverted.map((m) => m.name)).toEqual(["Migration20260101000000_spike"]);
      expect(await exists()).toBe(false);
    } finally {
      await migrating.close(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("B4: Nest MikroOrmModule + RequestContext", () => {
    @Controller("accounts")
    class AccountsController {
      constructor(private readonly em: EntityManager) {}

      @Get(":id")
      async show(
        @Param("id") id: string,
      ): Promise<{ contextId: number | undefined; balance: string }> {
        // allowGlobalContext=false: this only works if the request has its own forked EM.
        const account = await this.em.findOneOrFail(SpikeAccount, id);
        return { contextId: RequestContext.getEntityManager()?.id, balance: account.balance };
      }
    }

    let app: INestApplication;
    let baseUrl: string;

    beforeAll(async () => {
      @Module({
        imports: [
          MikroOrmModule.forRoot({
            ...buildOrmOptions(db.config, { entities: [SpikeAccount] }),
            driver: PostgreSqlDriver,
          }),
        ],
        controllers: [AccountsController],
      })
      class SpikeOrmModule {}

      const moduleRef = await Test.createTestingModule({ imports: [SpikeOrmModule] }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      await app.listen(0, "127.0.0.1");
      baseUrl = await app.getUrl();
    });

    afterAll(async () => {
      await app.close();
    });

    test("each request gets its own EntityManager via AsyncLocalStorage", async () => {
      const id = await insertAccount("42.00");
      const responses = await Promise.all(
        [1, 2, 3].map(async () => {
          const res = await fetch(`${baseUrl}/accounts/${id}`);
          expect(res.status).toBe(200);
          return (await res.json()) as { contextId: number | undefined; balance: string };
        }),
      );
      expect(responses.every((r) => r.balance === "42.00")).toBe(true);
      const ids = responses.map((r) => r.contextId);
      expect(ids.every((value) => typeof value === "number")).toBe(true);
      expect(new Set(ids).size).toBe(3);
    });
  });
});
