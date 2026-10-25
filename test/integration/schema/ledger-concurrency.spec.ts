import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { SQLSTATE, expectViolation } from "../../support/constraint-assertions.ts";
import { createIsolatedDatabase, openSql } from "../../support/database.ts";
import type { IsolatedDatabase } from "../../support/database.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { waitFor } from "../../support/polling.ts";
import { SqlFixtures, T0, insertRow, transactionRow, uuid } from "../../support/sql-fixtures.ts";

/**
 * The schema alone serializes writers of one wallet: two connections run the naive
 * "read → calculate → write" with NO application lock, both computing 100.00 − 80.00 from the
 * same starting point. The chain trigger locks the wallet row, so the second writer waits for the
 * first, then sees the committed entry and is refused: one debit, balance 20.00, never negative.
 */
describe("ledger chain as a concurrency backstop (no application lock)", () => {
  let db: IsolatedDatabase;
  let admin: SQL;
  let first: SQL;
  let second: SQL;

  beforeAll(async () => {
    db = await createIsolatedDatabase("schema-ledger-concurrency");
    admin = openSql(db.name, 2);
    first = openSql(db.name);
    second = openSql(db.name);
  });

  afterAll(async () => {
    await Promise.all([first.close(), second.close(), admin.close()]);
    await db.drop();
  });

  async function naiveBet(conn: SQL, walletId: string, playerId: string): Promise<void> {
    // Both writers "read" 100.00 / version 1 and compute the same new state.
    const tx = transactionRow(walletId, {
      player_id: playerId,
      amount: "80.00",
      observed_balance_amount: "20.00",
    });
    await conn.begin(async (db) => {
      await insertRow(db, "wager_transactions", tx);
      await insertRow(db, "wallet_ledger_entries", {
        id: uuid(),
        wallet_id: walletId,
        transaction_id: tx["id"],
        direction: "DEBIT",
        amount: "80.00",
        currency: "BRL",
        balance_before: "100.00",
        balance_after: "20.00",
        wallet_version: 2,
        created_at: T0,
      });
      await db.unsafe("update wallets set balance = 20.00, version = 2 where id = $1", [walletId]);
    });
  }

  test("two simultaneous 80.00 debits on 100.00: exactly one commits", async () => {
    const wallet = await new SqlFixtures(admin).openWallet({ balance: "100.00" });

    // Writer 1 takes the wallet row lock (via the chain trigger) and holds its transaction open.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holdingLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => (holdingLock = resolve));
    const firstWriter = first.begin(async (db) => {
      const tx = transactionRow(wallet.id, {
        player_id: wallet.playerId,
        amount: "80.00",
        observed_balance_amount: "20.00",
      });
      await insertRow(db, "wager_transactions", tx);
      await insertRow(db, "wallet_ledger_entries", {
        id: uuid(),
        wallet_id: wallet.id,
        transaction_id: tx["id"],
        direction: "DEBIT",
        amount: "80.00",
        currency: "BRL",
        balance_before: "100.00",
        balance_after: "20.00",
        wallet_version: 2,
        created_at: T0,
      });
      await db.unsafe("update wallets set balance = 20.00, version = 2 where id = $1", [wallet.id]);
      holdingLock();
      await gate;
    });

    // Writer 2 starts only once writer 1 holds the lock (otherwise either could win the race),
    // runs the same computation and must block on the wallet row.
    await lockHeld;
    const secondWriter = expectViolation(() => naiveBet(second, wallet.id, wallet.playerId), {
      sqlState: SQLSTATE.checkViolation,
      constraint: "wallet_ledger_entries_chain",
    });
    await waitFor(
      async () => {
        const rows: { waiting: number }[] = await admin.unsafe(
          `select count(*)::int as waiting from pg_stat_activity
            where datname = $1 and wait_event_type = 'Lock'`,
          [db.name],
        );
        return (rows[0]?.waiting ?? 0) > 0;
      },
      { description: "second writer blocked on the wallet row lock" },
    );

    release();
    await firstWriter;
    await secondWriter;

    const debits: { count: number; balance: string }[] = await admin.unsafe(
      `select (select count(*)::int from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT') as count,
              (select balance::text from wallets where id = $1) as balance`,
      [wallet.id],
    );
    expect(debits[0]).toEqual({ count: 1, balance: "20.00" });
    await assertLedgerInvariant(admin, wallet.id);
  });
  test("free race, either may win: one commits, the other is refused by the chain", async () => {
    for (let round = 0; round < 10; round += 1) {
      const wallet = await new SqlFixtures(admin).openWallet({ balance: "100.00" });
      const results = await Promise.allSettled([
        naiveBet(first, wallet.id, wallet.playerId),
        naiveBet(second, wallet.id, wallet.playerId),
      ]);
      const refused = results.filter((r) => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const reason: unknown = refused[0]?.status === "rejected" ? refused[0].reason : undefined;
      expect((reason as { constraint?: unknown } | undefined)?.constraint).toBe(
        "wallet_ledger_entries_chain",
      );
      const rows: { balance: string }[] = await admin.unsafe(
        "select balance::text as balance from wallets where id = $1",
        [wallet.id],
      );
      expect(rows[0]?.balance).toBe("20.00");
      await assertLedgerInvariant(admin, wallet.id);
    }
  });
});
