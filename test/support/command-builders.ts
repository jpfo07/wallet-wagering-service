import type { SQL } from "bun";
import type { RequestContext } from "../../src/application/request-context.ts";
import type { WagerTransactionCommand } from "../../src/application/wager/process-wager-transaction.ts";
import type { WalletView } from "../../src/application/views.ts";
import type { Application } from "../../src/infrastructure/application/composition.ts";

export const PROVIDER = "provider-a";
export const CTX: RequestContext = { correlationId: "corr-test" };

const uuid = (): string => Bun.randomUUIDv7();

export async function createWallet(
  app: Application,
  balance = "100.00",
  currency = "BRL",
): Promise<WalletView> {
  return app.createWallet.execute(
    { playerId: uuid(), initialBalance: { amount: balance, currency } },
    CTX,
  );
}

export type WagerKind = "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";

export interface WagerOverrides {
  readonly externalTransactionId?: string;
  readonly idempotencyKey?: string;
  readonly providerId?: string;
  readonly playerId?: string;
  readonly walletId?: string;
  readonly roundId?: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly reference?: string;
}

/** A valid command for the wallet; a fresh externalTransactionId (and default key) unless given. */
export function wagerCommand(
  wallet: WalletView,
  kind: WagerKind,
  overrides: WagerOverrides = {},
): WagerTransactionCommand {
  const providerId = overrides.providerId ?? PROVIDER;
  const externalTransactionId =
    overrides.externalTransactionId ?? `${kind.toLowerCase()}-${uuid()}`;
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    playerId: overrides.playerId ?? wallet.playerId,
    walletId: overrides.walletId ?? wallet.id,
    roundId: overrides.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind,
    money: {
      amount: overrides.amount ?? "10.00",
      currency: overrides.currency ?? wallet.balance.currency,
    },
    ...(overrides.reference === undefined
      ? {}
      : { referenceExternalTransactionId: overrides.reference }),
  };
}

/** Awaits every promise and splits fulfilled values from rejection reasons. */
export async function settleAll<T>(
  promises: readonly Promise<T>[],
): Promise<{ readonly values: T[]; readonly errors: unknown[] }> {
  const results = await Promise.allSettled(promises);
  const values: T[] = [];
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") values.push(result.value);
    else errors.push(result.reason);
  }
  return { values, errors };
}

// ---- inspection (raw SQL, independent of the code under test)

export interface WalletState {
  readonly balance: string;
  readonly version: number;
}

export async function walletState(sql: SQL, walletId: string): Promise<WalletState> {
  const rows: WalletState[] = await sql.unsafe(
    "select balance::text as balance, version from wallets where id = $1",
    [walletId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`wallet ${walletId} not found`);
  return row;
}

export interface LedgerRow {
  readonly transaction_id: string;
  readonly direction: string;
  readonly amount: string;
  readonly wallet_version: number;
}

export async function ledgerRows(sql: SQL, walletId: string): Promise<LedgerRow[]> {
  return sql.unsafe(
    `select transaction_id, direction, amount::text as amount, wallet_version
       from wallet_ledger_entries where wallet_id = $1 order by wallet_version`,
    [walletId],
  );
}

export interface TransactionRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly external_transaction_id: string;
  readonly observed_balance: string | null;
}

export async function transactionRows(sql: SQL, walletId: string): Promise<TransactionRow[]> {
  return sql.unsafe(
    `select id, kind, status, failure_code, external_transaction_id,
            observed_balance_amount::text as observed_balance
       from wager_transactions where wallet_id = $1 order by created_at, id`,
    [walletId],
  );
}

/** Event types in the outbox for the wallet (aggregateId = walletId), in insertion order. */
export async function outboxEventTypes(sql: SQL, walletId: string): Promise<string[]> {
  const rows: { event_type: string }[] = await sql.unsafe(
    "select event_type from outbox_messages where aggregate_id = $1 order by occurred_at, id",
    [walletId],
  );
  return rows.map((row) => row.event_type);
}

export async function inboxRow(
  sql: SQL,
  consumerName: string,
  messageId: string,
): Promise<{ readonly processed: boolean } | undefined> {
  const rows: { processed: boolean }[] = await sql.unsafe(
    `select processed_at is not null as processed from inbox_messages
      where consumer_name = $1 and message_id = $2`,
    [consumerName, messageId],
  );
  return rows[0];
}
