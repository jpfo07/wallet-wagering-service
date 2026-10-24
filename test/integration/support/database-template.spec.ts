import { describe, expect, test } from "bun:test";
import {
  TEMPLATE_DATABASE,
  TemplateInUseError,
  cloneDatabase,
  createIsolatedDatabase,
  dropDatabase,
  openSql,
  withTemplateLock,
} from "../../support/database.ts";

describe("test database isolation", () => {
  test("each suite gets its own database cloned from the migrated template", async () => {
    const a = await createIsolatedDatabase("isolation-a");
    const b = await createIsolatedDatabase("isolation-a");
    try {
      expect(a.name).not.toBe(b.name);
      const sql = openSql(a.name);
      try {
        const rows: { current_database: string }[] = await sql.unsafe("select current_database()");
        expect(rows[0]?.current_database).toBe(a.name);
      } finally {
        await sql.close();
      }
    } finally {
      await a.drop();
      await b.drop();
    }
  });

  test("cloning while someone is connected to the template fails with a clear message", async () => {
    await withTemplateLock(async (admin) => {
      const intruder = openSql(TEMPLATE_DATABASE);
      const target = `wws_template_in_use_${Bun.randomUUIDv7().replaceAll("-", "").slice(-8)}`;
      try {
        await intruder.unsafe("select 1");
        let caught: unknown;
        try {
          await cloneDatabase(admin, TEMPLATE_DATABASE, target);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(TemplateInUseError);
        const message = (caught as Error).message;
        expect(message).toContain(TEMPLATE_DATABASE);
        expect(message).toContain("55006");
        expect(message).toMatch(/pid=\d+/);
      } finally {
        await intruder.close();
        await dropDatabase(target);
      }
    });
    // PostgreSQL keeps retrying for ~5s before giving up with 55006.
  }, 20_000);
});
