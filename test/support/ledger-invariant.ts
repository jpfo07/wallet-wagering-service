import { expect } from "bun:test";
import type { SQL } from "bun";
import { Money } from "../../src/domain/shared/money.ts";

/**
 * The final invariant of every integration/concurrency test: wallet.balance == balance rebuilt from
 * the ledger alone. Amounts stay strings → Money; nothing goes through `number`.
 */
export async function assertLedgerInvariant(sql: SQL, walletId: string): Promise<void> {
  const wallets: { balance: string; currency: string }[] = await sql.unsafe(
    `select balance::text as balance, currency from wallets where id = $1`,
    [walletId],
  );
  const wallet = wallets[0];
  if (wallet === undefined) throw new Error(`wallet ${walletId} not found`);
  const entries: { direction: string; amount: string }[] = await sql.unsafe(
    `select direction, amount::text as amount from wallet_ledger_entries
      where wallet_id = $1 order by wallet_version`,
    [walletId],
  );
  const rebuilt = entries.reduce((balance, entry) => {
    const money = Money.from({ amount: entry.amount, currency: wallet.currency });
    return entry.direction === "CREDIT" ? balance.add(money) : balance.subtract(money);
  }, Money.zero(wallet.currency));
  expect(rebuilt.amount).toBe(
    Money.from({ amount: wallet.balance, currency: wallet.currency }).amount,
  );
}
