import { describe, expect, test } from "bun:test";
import { SQLSTATE, expectViolation } from "../../support/constraint-assertions.ts";
import { sqlStateOf } from "../../support/database.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { useSchemaSuite } from "../../support/schema-suite.ts";
import { insertRow, walletRow } from "../../support/sql-fixtures.ts";

const suite = useSchemaSuite("schema-wallets");
const check = (constraint: string) => ({ sqlState: SQLSTATE.checkViolation, constraint });

describe("wallets: accepted states", () => {
  test("a wallet opened with zero (no ledger) and one with an OPENING credit", async () => {
    const { sql, fx } = suite();
    const empty = await fx.openWallet({ balance: "0.00" });
    const funded = await fx.openWallet({ balance: "100.00" });
    await fx.move(funded, { kind: "BET", amount: "30.00" });
    await assertLedgerInvariant(sql, empty.id);
    await assertLedgerInvariant(sql, funded.id);
  });

  test("the same player may hold wallets in different currencies", async () => {
    const { sql } = suite();
    const row = walletRow();
    await insertRow(sql, "wallets", row);
    await insertRow(sql, "wallets", walletRow({ player_id: row["player_id"], currency: "USD" }));
  });
});

describe("wallets: refused by the database", () => {
  test("a second wallet for the same player + currency", async () => {
    const { sql } = suite();
    const row = walletRow();
    await insertRow(sql, "wallets", row);
    await expectViolation(
      () => insertRow(sql, "wallets", walletRow({ player_id: row["player_id"] })),
      { sqlState: SQLSTATE.uniqueViolation, constraint: "wallets_player_currency_uq" },
    );
  });

  test("negative balance", async () => {
    const { sql } = suite();
    await expectViolation(
      () => insertRow(sql, "wallets", walletRow({ balance: "-0.01" })),
      check("wallets_balance_non_negative_chk"),
    );
  });

  test("version below 1: refused by the trigger and, beneath it, by the CHECK", async () => {
    const { sql } = suite();
    await expectViolation(
      () => insertRow(sql, "wallets", walletRow({ version: 0 })),
      check("wallets_initial_version"),
    );
    // Defense in depth: even with the trigger out of the way, the CHECK still refuses.
    await expectViolation(
      () =>
        sql.begin(async (tx) => {
          await tx.unsafe(`alter table wallets disable trigger wallets_guard`);
          await insertRow(tx, "wallets", walletRow({ version: 0 }));
        }),
      check("wallets_version_min_chk"),
    );
  });

  test("currency longer than 3 characters is refused by the char(3) type itself", async () => {
    const { sql } = suite();
    let sqlState: string | undefined;
    try {
      await insertRow(sql, "wallets", walletRow({ currency: "BRLX" }));
    } catch (error) {
      sqlState = sqlStateOf(error);
    }
    expect(sqlState).toBe("22001");
  });

  test.each(["brl", "BR", "B1L"])("currency %p", async (currency) => {
    const { sql } = suite();
    await expectViolation(
      () => insertRow(sql, "wallets", walletRow({ currency })),
      check("wallets_currency_format_chk"),
    );
  });

  test("created with a version other than 1", async () => {
    const { sql } = suite();
    await expectViolation(
      () => insertRow(sql, "wallets", walletRow({ version: 2 })),
      check("wallets_initial_version"),
    );
  });

  test.each([
    ["player_id", () => `player_id = '${Bun.randomUUIDv7()}'`],
    ["currency", () => `currency = 'USD'`],
    ["created_at", () => `created_at = created_at + interval '1 second'`],
  ])("changing the wallet identity (%s)", async (_label, assignment) => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet({ balance: "0.00" });
    await expectViolation(
      () => sql.unsafe(`update wallets set ${assignment()} where id = $1`, [wallet.id]),
      check("wallets_identity_immutable"),
    );
  });

  test("balance changes without version + 1", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet();
    await expectViolation(
      () => sql.unsafe(`update wallets set balance = 90.00 where id = $1`, [wallet.id]),
      check("wallets_version_rule"),
    );
    await expectViolation(
      () =>
        sql.unsafe(`update wallets set balance = 90.00, version = 3 where id = $1`, [wallet.id]),
      check("wallets_version_rule"),
    );
  });

  test("version changes without a balance change", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet();
    await expectViolation(
      () => sql.unsafe(`update wallets set version = 2 where id = $1`, [wallet.id]),
      check("wallets_version_rule"),
    );
  });

  test("DELETE and TRUNCATE", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet({ balance: "0.00" });
    await expectViolation(
      () => sql.unsafe(`delete from wallets where id = $1`, [wallet.id]),
      check("wallets_no_delete"),
    );
    await expectViolation(() => sql.unsafe(`truncate wallets cascade`), check("wallets_no_delete"));
    const rows: unknown[] = await sql.unsafe(`select 1 from wallets where id = $1`, [wallet.id]);
    expect(rows).toHaveLength(1);
  });

  test("a balance with no ledger behind it (checked at COMMIT)", async () => {
    const { sql } = suite();
    await expectViolation(
      () => insertRow(sql, "wallets", walletRow({ balance: "50.00" })),
      check("wallets_matches_ledger"),
    );
  });

  test("a version bump with a matching balance but no ledger entry (checked at COMMIT)", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet();
    await expectViolation(
      () =>
        sql.unsafe(`update wallets set balance = 90.00, version = 2 where id = $1`, [wallet.id]),
      check("wallets_matches_ledger"),
    );
    await assertLedgerInvariant(sql, wallet.id);
  });
});
