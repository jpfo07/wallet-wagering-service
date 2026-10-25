import type { SQL } from "bun";
import { Money } from "../../src/domain/shared/money.ts";

/**
 * Raw-SQL fixtures for the schema tests. They bypass the domain and the ORM on purpose: the point
 * is to show what the database itself accepts and refuses. Every helper writes a *coherent* state
 * (wallet + transaction + ledger in one SQL transaction); a test then changes one thing and expects
 * the refusal.
 */

export type Row = Record<string, unknown>;
type Executor = Pick<SQL, "unsafe">;

export const T0 = new Date("2026-07-29T15:00:00.000Z");
export const HASH = "a".repeat(64);

export const uuid = (): string => Bun.randomUUIDv7();

export async function insertRow(db: Executor, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  await db.unsafe(
    `insert into ${table} (${columns.join(", ")}) values (${placeholders})`,
    Object.values(row),
  );
}

export function walletRow(overrides: Row = {}): Row {
  return {
    id: uuid(),
    player_id: uuid(),
    currency: "BRL",
    balance: "0.00",
    version: 1,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function transactionRow(walletId: string, overrides: Row = {}): Row {
  const externalId = `ext-${uuid()}`;
  return {
    id: uuid(),
    provider_id: "provider-a",
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: HASH,
    wallet_id: walletId,
    player_id: uuid(),
    round_id: "round-1",
    game_id: "fortune-chimp",
    kind: "BET",
    amount: "10.00",
    currency: "BRL",
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: "PROCESSED",
    failure_code: null,
    processed_at: T0,
    observed_balance_amount: "0.00",
    observed_balance_currency: "BRL",
    reference_attempts: 0,
    next_reference_check_at: null,
    reference_expires_at: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

/** A REJECTED transaction: never touches wallet or ledger, so it inserts on its own. */
export function rejectedRow(walletId: string, overrides: Row = {}): Row {
  return transactionRow(walletId, {
    status: "REJECTED",
    failure_code: "INSUFFICIENT_FUNDS",
    processed_at: null,
    ...overrides,
  });
}

/** A PENDING_REFERENCE transaction (a REFUND waiting for its BET by default). */
export function pendingReferenceRow(walletId: string, overrides: Row = {}): Row {
  return transactionRow(walletId, {
    kind: "REFUND",
    status: "PENDING_REFERENCE",
    processed_at: null,
    reference_external_transaction_id: `missing-${uuid()}`,
    next_reference_check_at: T0,
    reference_expires_at: new Date(T0.getTime() + 15 * 60_000),
    ...overrides,
  });
}

export interface SeededWallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  balance: Money;
  version: number;
}

export interface Movement {
  readonly transactionId: string;
  readonly externalId: string;
  readonly entryId: string;
  readonly direction: "DEBIT" | "CREDIT";
}

export class SqlFixtures {
  constructor(readonly sql: SQL) {}

  /** Wallet + (when > 0) OPENING transaction + CREDIT entry 0 → balance, in one SQL transaction. */
  async openWallet(props: { balance?: string; currency?: string } = {}): Promise<SeededWallet> {
    const currency = props.currency ?? "BRL";
    const balance = Money.from({ amount: props.balance ?? "100.00", currency });
    const wallet: SeededWallet = {
      id: uuid(),
      playerId: uuid(),
      currency,
      balance: Money.zero(currency),
      version: 1,
    };
    await this.sql.begin(async (tx) => {
      await insertRow(
        tx,
        "wallets",
        walletRow({
          id: wallet.id,
          player_id: wallet.playerId,
          currency,
          balance: balance.amount,
        }),
      );
      if (balance.isPositive()) {
        const transactionId = uuid();
        await insertRow(
          tx,
          "wager_transactions",
          transactionRow(wallet.id, {
            id: transactionId,
            provider_id: "internal",
            external_transaction_id: `opening:${wallet.id}`,
            idempotency_key: `internal:opening:${wallet.id}`,
            player_id: wallet.playerId,
            round_id: "opening",
            game_id: "opening",
            kind: "OPENING",
            amount: balance.amount,
            currency,
            observed_balance_amount: balance.amount,
            observed_balance_currency: currency,
          }),
        );
        await insertRow(tx, "wallet_ledger_entries", {
          id: uuid(),
          wallet_id: wallet.id,
          transaction_id: transactionId,
          direction: "CREDIT",
          amount: balance.amount,
          currency,
          balance_before: "0.00",
          balance_after: balance.amount,
          wallet_version: 1,
          created_at: T0,
        });
      }
    });
    wallet.balance = balance;
    return wallet;
  }

  /**
   * A PROCESSED balance-moving transaction applied the way the use case will: transaction, ledger
   * entry and wallet update in one SQL transaction. `transaction` overrides the row (kind,
   * reference...); `direction` defaults to what the kind implies.
   */
  async move(
    wallet: SeededWallet,
    props: {
      kind: "BET" | "WIN" | "REFUND" | "ROLLBACK";
      amount: string;
      direction?: "DEBIT" | "CREDIT";
      transaction?: Row;
    },
  ): Promise<Movement> {
    const direction = props.direction ?? (props.kind === "BET" ? "DEBIT" : "CREDIT");
    const money = Money.from({ amount: props.amount, currency: wallet.currency });
    const before = wallet.balance;
    const after = direction === "CREDIT" ? before.add(money) : before.subtract(money);
    const version = wallet.version + 1;
    const row = transactionRow(wallet.id, {
      player_id: wallet.playerId,
      kind: props.kind,
      amount: money.amount,
      currency: wallet.currency,
      observed_balance_amount: after.amount,
      observed_balance_currency: wallet.currency,
      ...props.transaction,
    });
    const movement: Movement = {
      transactionId: String(row["id"]),
      externalId: String(row["external_transaction_id"]),
      entryId: uuid(),
      direction,
    };
    await this.sql.begin(async (tx) => {
      await insertRow(tx, "wager_transactions", row);
      await insertRow(tx, "wallet_ledger_entries", {
        id: movement.entryId,
        wallet_id: wallet.id,
        transaction_id: movement.transactionId,
        direction,
        amount: money.amount,
        currency: wallet.currency,
        balance_before: before.amount,
        balance_after: after.amount,
        wallet_version: version,
        created_at: T0,
      });
      await tx.unsafe(`update wallets set balance = $1, version = $2 where id = $3`, [
        after.amount,
        version,
        wallet.id,
      ]);
    });
    wallet.balance = after;
    wallet.version = version;
    return movement;
  }
}
