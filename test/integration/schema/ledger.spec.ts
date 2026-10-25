import { describe, test } from "bun:test";
import { Money } from "../../../src/domain/shared/money.ts";
import { SQLSTATE, expectViolation } from "../../support/constraint-assertions.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { useSchemaSuite } from "../../support/schema-suite.ts";
import {
  T0,
  insertRow,
  pendingReferenceRow,
  rejectedRow,
  transactionRow,
  uuid,
} from "../../support/sql-fixtures.ts";
import type { Row, SeededWallet } from "../../support/sql-fixtures.ts";

const suite = useSchemaSuite("schema-ledger");
const check = (constraint: string) => ({ sqlState: SQLSTATE.checkViolation, constraint });
const fk = (constraint: string) => ({ sqlState: SQLSTATE.foreignKeyViolation, constraint });
const unique = (constraint: string) => ({ sqlState: SQLSTATE.uniqueViolation, constraint });

function entryRow(wallet: SeededWallet, transactionId: string, overrides: Row = {}): Row {
  return {
    id: uuid(),
    wallet_id: wallet.id,
    transaction_id: transactionId,
    direction: "DEBIT",
    amount: "10.00",
    currency: wallet.currency,
    balance_before: wallet.balance.amount,
    balance_after: wallet.balance.subtract(
      Money.from({ amount: "10.00", currency: wallet.currency }),
    ).amount,
    wallet_version: wallet.version + 1,
    created_at: T0,
    ...overrides,
  };
}

/** Inserts a transaction row and a ledger entry for it in one SQL transaction (no wallet update). */
async function insertWithEntry(tx: Row, entry: Row): Promise<void> {
  await suite().sql.begin(async (db) => {
    await insertRow(db, "wager_transactions", tx);
    await insertRow(db, "wallet_ledger_entries", entry);
  });
}

/** BET of 10.00 on a 100.00 wallet: the row a ledger test then breaks in one place. */
async function betSetup(): Promise<{ wallet: SeededWallet; tx: Row }> {
  const wallet = await suite().fx.openWallet({ balance: "100.00" });
  return { wallet, tx: transactionRow(wallet.id, { player_id: wallet.playerId, amount: "10.00" }) };
}

describe("wallet_ledger_entries: append-only", () => {
  test.each([
    ["UPDATE", "update wallet_ledger_entries set created_at = now() where wallet_id = $1"],
    ["DELETE", "delete from wallet_ledger_entries where wallet_id = $1"],
  ])("%s is refused", async (_label, statement) => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet();
    await expectViolation(
      () => sql.unsafe(statement, [wallet.id]),
      check("wallet_ledger_entries_append_only"),
    );
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("TRUNCATE is refused", async () => {
    const { sql } = suite();
    await expectViolation(
      () => sql.unsafe("truncate wallet_ledger_entries"),
      check("wallet_ledger_entries_append_only"),
    );
  });
});

describe("wallet_ledger_entries: row checks", () => {
  test.each<[string, Row, string]>([
    [
      "CREDIT that does not add up",
      { direction: "CREDIT", balance_after: "111.00" },
      "wallet_ledger_entries_arithmetic_chk",
    ],
    [
      "DEBIT that does not add up",
      { balance_after: "91.00" },
      "wallet_ledger_entries_arithmetic_chk",
    ],
    [
      "direction other than DEBIT/CREDIT (enforced by the arithmetic check)",
      { direction: "SIDEWAYS" },
      "wallet_ledger_entries_arithmetic_chk",
    ],
    [
      "zero amount",
      { amount: "0.00", balance_after: "100.00" },
      "wallet_ledger_entries_amount_positive_chk",
    ],
    [
      "balance going below zero",
      { amount: "150.00", balance_after: "-50.00" },
      "wallet_ledger_entries_balances_non_negative_chk",
    ],
    ["lowercase currency", { currency: "brl" }, "wallet_ledger_entries_currency_format_chk"],
  ])("%s", async (_label, overrides, constraint) => {
    const { wallet, tx } = await betSetup();
    await expectViolation(
      () => insertWithEntry(tx, entryRow(wallet, String(tx["id"]), overrides)),
      check(constraint),
    );
  });

  test("wallet_version below 1 (first entry of an empty wallet)", async () => {
    const { fx } = suite();
    const wallet = await fx.openWallet({ balance: "0.00" });
    const tx = transactionRow(wallet.id, { kind: "WIN" });
    await expectViolation(
      () =>
        insertWithEntry(
          tx,
          entryRow(wallet, String(tx["id"]), {
            direction: "CREDIT",
            balance_after: "10.00",
            wallet_version: 0,
          }),
        ),
      check("wallet_ledger_entries_wallet_version_chk"),
    );
  });
});

describe("wallet_ledger_entries: coherent with its wallet and transaction", () => {
  test("a second entry for the same transaction", async () => {
    const { fx } = suite();
    const wallet = await fx.openWallet();
    const bet = await fx.move(wallet, { kind: "BET", amount: "10.00" });
    await expectViolation(
      () => insertRow(suite().sql, "wallet_ledger_entries", entryRow(wallet, bet.transactionId)),
      unique("wallet_ledger_entries_transaction_uq"),
    );
  });

  test("entry for a transaction that does not exist (deferred FK, at COMMIT)", async () => {
    const { wallet } = await betSetup();
    await expectViolation(
      () =>
        suite().sql.begin(async (db) => {
          await insertRow(db, "wallet_ledger_entries", entryRow(wallet, uuid()));
          await db.unsafe("update wallets set balance = 90.00, version = 2 where id = $1", [
            wallet.id,
          ]);
        }),
      fk("wallet_ledger_entries_transaction_fk"),
    );
  });

  test("currency different from the wallet's", async () => {
    const { wallet, tx } = await betSetup();
    await expectViolation(
      () => insertWithEntry(tx, entryRow(wallet, String(tx["id"]), { currency: "USD" })),
      fk("wallet_ledger_entries_wallet_fk"),
    );
  });

  test("amount different from the transaction's", async () => {
    const { wallet, tx } = await betSetup();
    await expectViolation(
      () =>
        insertWithEntry(
          tx,
          entryRow(wallet, String(tx["id"]), { amount: "20.00", balance_after: "80.00" }),
        ),
      fk("wallet_ledger_entries_transaction_fk"),
    );
  });

  test("entry on a wallet other than the transaction's", async () => {
    const { fx } = suite();
    const { tx } = await betSetup();
    const other = await fx.openWallet();
    await expectViolation(
      () => insertWithEntry(tx, entryRow(other, String(tx["id"]))),
      fk("wallet_ledger_entries_transaction_fk"),
    );
  });
});

describe("wallet_ledger_entries: the chain per wallet (T4)", () => {
  test("balance_before that is not the previous balance_after", async () => {
    const { wallet, tx } = await betSetup();
    await expectViolation(
      () =>
        insertWithEntry(
          tx,
          entryRow(wallet, String(tx["id"]), { balance_before: "50.00", balance_after: "40.00" }),
        ),
      check("wallet_ledger_entries_chain"),
    );
  });

  test.each([
    ["repeated", 1],
    ["going backwards", 0],
  ])("wallet_version %s", async (_label, version) => {
    const { wallet, tx } = await betSetup();
    await expectViolation(
      () => insertWithEntry(tx, entryRow(wallet, String(tx["id"]), { wallet_version: version })),
      check("wallet_ledger_entries_chain"),
    );
  });

  test("the first entry of a wallet must start at 0.00", async () => {
    const { fx } = suite();
    const wallet = await fx.openWallet({ balance: "0.00" });
    const tx = transactionRow(wallet.id, { kind: "WIN" });
    await expectViolation(
      () =>
        insertWithEntry(
          tx,
          entryRow(wallet, String(tx["id"]), {
            direction: "CREDIT",
            balance_before: "5.00",
            balance_after: "15.00",
          }),
        ),
      check("wallet_ledger_entries_chain"),
    );
  });

  test("beneath the trigger, (wallet_id, wallet_version) is still unique", async () => {
    const { sql } = suite();
    const { wallet, tx } = await betSetup();
    await expectViolation(
      () =>
        sql.begin(async (db) => {
          await db.unsafe(
            "alter table wallet_ledger_entries disable trigger wallet_ledger_entries_chain",
          );
          await insertRow(db, "wager_transactions", tx);
          await insertRow(
            db,
            "wallet_ledger_entries",
            entryRow(wallet, String(tx["id"]), { wallet_version: 1 }),
          );
        }),
      unique("wallet_ledger_entries_wallet_version_uq"),
    );
  });
});

describe("ledger × transaction × wallet, checked at COMMIT (T5–T7)", () => {
  /** Transaction + entry + wallet update (wallet ends at `balanceAfter`), in one SQL transaction. */
  async function entryFor(
    wallet: SeededWallet,
    tx: Row,
    entry: { direction?: string; balanceAfter?: string } = {},
  ): Promise<void> {
    const balanceAfter = entry.balanceAfter ?? "90.00";
    const overrides: Row = { balance_after: balanceAfter };
    if (entry.direction !== undefined) overrides["direction"] = entry.direction;
    await suite().sql.begin(async (db) => {
      await insertRow(db, "wager_transactions", tx);
      await insertRow(db, "wallet_ledger_entries", entryRow(wallet, String(tx["id"]), overrides));
      await db.unsafe("update wallets set balance = $1, version = $2 where id = $3", [
        balanceAfter,
        wallet.version + 1,
        wallet.id,
      ]);
    });
  }

  test.each<[string, (walletId: string) => Row]>([
    ["REJECTED", (walletId) => rejectedRow(walletId, { amount: "10.00" })],
    ["PENDING_REFERENCE", (walletId) => pendingReferenceRow(walletId, { amount: "10.00" })],
    ["LOSS", (walletId) => transactionRow(walletId, { kind: "LOSS", amount: "10.00" })],
  ])("an entry for a %s transaction", async (_label, row) => {
    const { wallet } = await betSetup();
    await expectViolation(
      () => entryFor(wallet, row(wallet.id)),
      check("wallet_ledger_entries_matches_transaction"),
    );
  });

  test("a BET that credits", async () => {
    const { wallet, tx } = await betSetup();
    await expectViolation(
      () => entryFor(wallet, tx, { direction: "CREDIT", balanceAfter: "110.00" }),
      check("wallet_ledger_entries_matches_transaction"),
    );
  });

  test("a ROLLBACK of a WIN that credits (it must debit)", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet({ balance: "100.00" });
    const win = await fx.move(wallet, { kind: "WIN", amount: "10.00" });
    const rollback = transactionRow(wallet.id, {
      kind: "ROLLBACK",
      amount: "10.00",
      reference_external_transaction_id: win.externalId,
      reference_transaction_id: win.transactionId,
    });
    await expectViolation(
      () => entryFor(wallet, rollback, { direction: "CREDIT", balanceAfter: "120.00" }),
      check("wallet_ledger_entries_matches_transaction"),
    );
    await fx.move(wallet, {
      kind: "ROLLBACK",
      amount: "10.00",
      direction: "DEBIT",
      transaction: {
        reference_external_transaction_id: win.externalId,
        reference_transaction_id: win.transactionId,
      },
    });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("an entry without the matching wallet update", async () => {
    const { wallet, tx } = await betSetup();
    await expectViolation(
      () => insertWithEntry(tx, entryRow(wallet, String(tx["id"]))),
      check("wallets_matches_ledger"),
    );
  });

  test("a PROCESSED BET without its entry", async () => {
    const { sql } = suite();
    const { tx } = await betSetup();
    await expectViolation(
      () => insertRow(sql, "wager_transactions", tx),
      check("wager_transactions_processed_has_entry"),
    );
  });

  test("PENDING_REFERENCE turned PROCESSED without an entry", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet({ balance: "100.00" });
    const bet = await fx.move(wallet, { kind: "BET", amount: "10.00" });
    const pending = pendingReferenceRow(wallet.id, {
      reference_external_transaction_id: bet.externalId,
    });
    await insertRow(sql, "wager_transactions", pending);
    await expectViolation(
      () =>
        sql.unsafe(
          `update wager_transactions
              set status = 'PROCESSED', reference_transaction_id = $2, processed_at = $3,
                  next_reference_check_at = null
            where id = $1`,
          [pending["id"], bet.transactionId, T0],
        ),
      check("wager_transactions_processed_has_entry"),
    );
    await assertLedgerInvariant(sql, wallet.id);
  });
});
