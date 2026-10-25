import type { SQL } from "bun";
import { waitFor } from "./polling.ts";

/** Backends of this database currently blocked waiting for a lock. */
export async function lockWaiters(sql: SQL): Promise<number> {
  const rows: { n: number }[] = await sql.unsafe(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Starting gate for races. Holds the wallet row lock (SELECT ... FOR UPDATE) from a separate raw
 * connection, as another instance would; starts `fire`; waits, by polling pg_stat_activity, until
 * `waiters` backends are blocked on that lock; only then releases it. Every contender is therefore
 * genuinely waiting on the database lock when the race starts: no sleeps, no luck.
 */
export async function raceOnWalletLock<T>(
  sql: SQL,
  walletId: string | readonly string[],
  waiters: number,
  fire: () => Promise<T>,
): Promise<T> {
  const walletIds = typeof walletId === "string" ? [walletId] : walletId;
  let started: Promise<T> | undefined;
  await sql.begin(async (tx) => {
    // Array literal: Bun.SQL's unsafe() does not serialize JS arrays as PostgreSQL arrays.
    await tx.unsafe("select id from wallets where id = any($1::uuid[]) order by id for update", [
      `{${walletIds.join(",")}}`,
    ]);
    started = fire();
    // Observed below, after the lock is released; avoid an unhandled rejection meanwhile.
    started.catch(() => undefined);
    await waitFor(async () => (await lockWaiters(sql)) >= waiters, {
      timeoutMs: 15_000,
      intervalMs: 10,
      description: `${waiters} transactions waiting on the lock of ${walletIds.join(", ")}`,
    });
  });
  if (started === undefined) throw new Error("race was not started");
  return started;
}

/**
 * Holds the wallet row lock until `release()` is called: the "another instance is stuck holding
 * this wallet" situation.
 */
export async function holdWalletLock(
  sql: SQL,
  walletId: string,
): Promise<{ release(): Promise<void> }> {
  let releaseLock!: () => void;
  const released = new Promise<void>((resolve) => (releaseLock = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const transaction = sql.begin(async (tx) => {
    await tx.unsafe("select id from wallets where id = $1 for update", [walletId]);
    locked();
    await released;
  });
  await Promise.race([isLocked, transaction]);
  return {
    async release() {
      releaseLock();
      await transaction;
    },
  };
}
