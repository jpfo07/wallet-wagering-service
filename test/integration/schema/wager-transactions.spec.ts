import { beforeAll, describe, expect, test } from "bun:test";
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
import type { Row } from "../../support/sql-fixtures.ts";

const suite = useSchemaSuite("schema-wager-transactions");
const check = (constraint: string) => ({ sqlState: SQLSTATE.checkViolation, constraint });
const fk = (constraint: string) => ({ sqlState: SQLSTATE.foreignKeyViolation, constraint });
const unique = (constraint: string) => ({ sqlState: SQLSTATE.uniqueViolation, constraint });

let walletId: string;
beforeAll(async () => {
  walletId = (await suite().fx.openWallet({ balance: "0.00" })).id;
});

const insertTx = (row: Row) => insertRow(suite().sql, "wager_transactions", row);
const rejected = (overrides: Row = {}) => rejectedRow(walletId, overrides);
const loss = (overrides: Row = {}) => transactionRow(walletId, { kind: "LOSS", ...overrides });

describe("wager_transactions: one row, one violated constraint", () => {
  test.each<[string, () => Row, { sqlState: string; constraint: string }]>([
    ["unknown kind", () => rejected({ kind: "JACKPOT" }), check("wager_transactions_kind_chk")],
    [
      "status PENDING is never persisted",
      () => loss({ status: "PENDING", processed_at: null }),
      check("wager_transactions_status_chk"),
    ],
    [
      "unknown failure code",
      () => rejected({ failure_code: "OOPS" }),
      check("wager_transactions_failure_code_chk"),
    ],
    [
      "REJECTED without failure_code",
      () => rejected({ failure_code: null }),
      check("wager_transactions_rejected_state_chk"),
    ],
    [
      "REJECTED with the FAILED-only code",
      () => rejected({ failure_code: "INTERNAL_PERMANENT_ERROR" }),
      check("wager_transactions_rejected_state_chk"),
    ],
    [
      "REJECTED with processed_at",
      () => rejected({ processed_at: T0 }),
      check("wager_transactions_rejected_state_chk"),
    ],
    [
      "REJECTED without observed balance",
      () => rejected({ observed_balance_amount: null, observed_balance_currency: null }),
      check("wager_transactions_rejected_state_chk"),
    ],
    [
      "FAILED with a business rejection code",
      () => rejected({ status: "FAILED", failure_code: "INSUFFICIENT_FUNDS" }),
      check("wager_transactions_failed_state_chk"),
    ],
    [
      "PROCESSED without processed_at",
      () => loss({ processed_at: null }),
      check("wager_transactions_processed_state_chk"),
    ],
    [
      "PROCESSED without observed balance",
      () => loss({ observed_balance_amount: null, observed_balance_currency: null }),
      check("wager_transactions_processed_state_chk"),
    ],
    [
      "PROCESSED with failure_code",
      () => loss({ failure_code: "INSUFFICIENT_FUNDS" }),
      check("wager_transactions_processed_state_chk"),
    ],
    [
      "PROCESSED with a reference that was never resolved",
      () => loss({ reference_external_transaction_id: "bet-x" }),
      check("wager_transactions_processed_state_chk"),
    ],
    [
      "PENDING_REFERENCE without next check",
      () => pendingReferenceRow(walletId, { next_reference_check_at: null }),
      check("wager_transactions_next_check_chk"),
    ],
    [
      "PENDING_REFERENCE without expiry",
      () => pendingReferenceRow(walletId, { reference_expires_at: null }),
      check("wager_transactions_pending_reference_state_chk"),
    ],
    [
      "PENDING_REFERENCE with a resolved reference id",
      () => pendingReferenceRow(walletId, { reference_transaction_id: uuid() }),
      check("wager_transactions_pending_reference_state_chk"),
    ],
    [
      "next check scheduled on a non-pending transaction",
      () => rejected({ next_reference_check_at: T0 }),
      check("wager_transactions_next_check_chk"),
    ],
    [
      "REFUND without reference",
      () => rejected({ kind: "REFUND" }),
      check("wager_transactions_reference_by_kind_chk"),
    ],
    [
      "ROLLBACK without reference",
      () => rejected({ kind: "ROLLBACK" }),
      check("wager_transactions_reference_by_kind_chk"),
    ],
    [
      "BET with reference",
      () => rejected({ reference_external_transaction_id: "bet-x" }),
      check("wager_transactions_reference_by_kind_chk"),
    ],
    [
      "self reference by external id",
      () =>
        rejected({
          kind: "WIN",
          external_transaction_id: "w-1",
          reference_external_transaction_id: "w-1",
        }),
      check("wager_transactions_no_self_reference_chk"),
    ],
    [
      "OPENING from an external provider",
      () => loss({ kind: "OPENING" }),
      check("wager_transactions_opening_internal_chk"),
    ],
    [
      "provider 'internal' submitting a BET",
      () => rejected({ provider_id: "internal" }),
      check("wager_transactions_opening_internal_chk"),
    ],
    [
      "OPENING that is not PROCESSED",
      () => rejected({ kind: "OPENING", provider_id: "internal" }),
      check("wager_transactions_opening_processed_chk"),
    ],
    [
      "BET with amount 0",
      () => rejected({ amount: "0.00" }),
      check("wager_transactions_amount_chk"),
    ],
    ["negative amount", () => loss({ amount: "-1.00" }), check("wager_transactions_amount_chk")],
    [
      "negative observed balance",
      () => rejected({ observed_balance_amount: "-0.01" }),
      check("wager_transactions_observed_balance_chk"),
    ],
    [
      "observed balance without currency",
      () => rejected({ observed_balance_currency: null }),
      check("wager_transactions_observed_balance_chk"),
    ],
    [
      "reference_attempts below 0",
      () => rejected({ reference_attempts: -1 }),
      check("wager_transactions_reference_attempts_chk"),
    ],
    [
      "payload hash that is not lowercase hex",
      () => rejected({ payload_hash: "A".repeat(64) }),
      check("wager_transactions_payload_hash_chk"),
    ],
    [
      "lowercase currency",
      () => rejected({ currency: "brl" }),
      check("wager_transactions_currency_format_chk"),
    ],
    [
      "blank provider_id",
      () => rejected({ provider_id: "   " }),
      check("wager_transactions_text_fields_chk"),
    ],
    [
      "round_id longer than 255",
      () => rejected({ round_id: "r".repeat(256) }),
      check("wager_transactions_text_fields_chk"),
    ],
    [
      "blank reference",
      () => rejected({ kind: "WIN", reference_external_transaction_id: " " }),
      check("wager_transactions_text_fields_chk"),
    ],
    [
      "wallet that does not exist",
      () =>
        rejected({
          wallet_id: uuid(),
          status: "FAILED",
          failure_code: "INTERNAL_PERMANENT_ERROR",
          observed_balance_amount: null,
          observed_balance_currency: null,
        }),
      fk("wager_transactions_wallet_fk"),
    ],
    [
      "observed balance in a currency other than the wallet's",
      () => rejected({ observed_balance_currency: "USD" }),
      fk("wager_transactions_observed_currency_fk"),
    ],
    [
      "reference id that does not exist",
      () =>
        rejected({
          kind: "WIN",
          reference_external_transaction_id: "bet-x",
          reference_transaction_id: uuid(),
        }),
      fk("wager_transactions_reference_fk"),
    ],
  ])("%s", async (_label, row, expected) => {
    await expectViolation(() => insertTx(row()), expected);
  });
});

describe("wager_transactions: states the domain produces are accepted", () => {
  test.each<[string, () => Row]>([
    ["LOSS with amount 0", () => loss({ amount: "0.00" })],
    [
      "CURRENCY_MISMATCH: USD transaction, BRL observed balance",
      () => rejected({ currency: "USD", failure_code: "CURRENCY_MISMATCH" }),
    ],
    [
      "FAILED without observed balance",
      () =>
        rejected({
          status: "FAILED",
          failure_code: "INTERNAL_PERMANENT_ERROR",
          observed_balance_amount: null,
          observed_balance_currency: null,
        }),
    ],
    ["PENDING_REFERENCE REFUND", () => pendingReferenceRow(walletId)],
  ])("%s", async (_label, row) => {
    await insertTx(row());
  });
});

describe("wager_transactions: idempotency and uniqueness", () => {
  test("same (provider, idempotency key) twice", async () => {
    const first = rejected();
    await insertTx(first);
    await expectViolation(
      () => insertTx(rejected({ idempotency_key: first["idempotency_key"] })),
      unique("wager_transactions_provider_idempotency_key_uq"),
    );
  });

  test("the same idempotency key under another provider is a different key", async () => {
    const first = rejected();
    await insertTx(first);
    await insertTx(
      rejected({ provider_id: "provider-b", idempotency_key: first["idempotency_key"] }),
    );
  });

  test("same (provider, external transaction id) twice, even with another key", async () => {
    const first = rejected();
    await insertTx(first);
    await expectViolation(
      () =>
        insertTx(
          rejected({
            external_transaction_id: first["external_transaction_id"],
            idempotency_key: `other-${uuid()}`,
          }),
        ),
      unique("wager_transactions_provider_external_uq"),
    );
  });

  test("the same external id under another provider is another operation", async () => {
    const first = rejected();
    await insertTx(first);
    await insertTx(
      rejected({
        provider_id: "provider-b",
        external_transaction_id: first["external_transaction_id"],
      }),
    );
  });
});

describe("wager_transactions: one PROCESSED reversal per reference", () => {
  test("REFUND then ROLLBACK of the same BET: the second reversal is refused", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet({ balance: "100.00" });
    const bet = await fx.move(wallet, { kind: "BET", amount: "10.00" });
    const reverses = {
      reference_external_transaction_id: bet.externalId,
      reference_transaction_id: bet.transactionId,
    };
    await fx.move(wallet, { kind: "REFUND", amount: "10.00", transaction: reverses });
    await expectViolation(
      () => fx.move(wallet, { kind: "ROLLBACK", amount: "10.00", transaction: reverses }),
      unique("wager_transactions_single_reversal_uq"),
    );
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("REJECTED reversals do not count, and a ROLLBACK of the REFUND reverses another row", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet({ balance: "100.00" });
    const bet = await fx.move(wallet, { kind: "BET", amount: "10.00" });
    const reverses = {
      reference_external_transaction_id: bet.externalId,
      reference_transaction_id: bet.transactionId,
    };
    for (let i = 0; i < 2; i += 1) {
      await insertTx(
        rejectedRow(wallet.id, { kind: "REFUND", failure_code: "AMOUNT_MISMATCH", ...reverses }),
      );
    }
    const refund = await fx.move(wallet, {
      kind: "REFUND",
      amount: "10.00",
      transaction: reverses,
    });
    await fx.move(wallet, {
      kind: "ROLLBACK",
      amount: "10.00",
      direction: "DEBIT",
      transaction: {
        reference_external_transaction_id: refund.externalId,
        reference_transaction_id: refund.transactionId,
      },
    });
    await assertLedgerInvariant(sql, wallet.id);
  });
});

describe("wager_transactions: terminal and business fields are immutable", () => {
  test.each<[string, () => Row]>([
    ["REJECTED", () => rejected()],
    ["FAILED", () => rejected({ status: "FAILED", failure_code: "INTERNAL_PERMANENT_ERROR" })],
    ["PROCESSED", () => loss()],
  ])("a %s transaction never changes", async (_label, row) => {
    const { sql } = suite();
    const stored = row();
    await insertTx(stored);
    await expectViolation(
      () =>
        sql.unsafe(`update wager_transactions set updated_at = now() where id = $1`, [
          stored["id"],
        ]),
      check("wager_transactions_terminal_immutable"),
    );
  });

  test.each([
    ["payload_hash", `payload_hash = '${"b".repeat(64)}'`],
    ["amount", "amount = 99.00"],
    ["idempotency_key", "idempotency_key = 'other'"],
    ["kind", "kind = 'ROLLBACK'"],
  ])("business field %s of a PENDING_REFERENCE transaction", async (_label, assignment) => {
    const { sql } = suite();
    const pending = pendingReferenceRow(walletId);
    await insertTx(pending);
    await expectViolation(
      () =>
        sql.unsafe(`update wager_transactions set ${assignment} where id = $1`, [pending["id"]]),
      check("wager_transactions_business_fields_immutable"),
    );
  });

  test("DELETE and TRUNCATE", async () => {
    const { sql } = suite();
    const stored = rejected();
    await insertTx(stored);
    await expectViolation(
      () => sql.unsafe(`delete from wager_transactions where id = $1`, [stored["id"]]),
      check("wager_transactions_no_delete"),
    );
    await expectViolation(
      () => sql.unsafe(`truncate wager_transactions cascade`),
      check("wager_transactions_no_delete"),
    );
  });

  test("PENDING_REFERENCE may be rescheduled and then rejected (worker path)", async () => {
    const { sql } = suite();
    const pending = pendingReferenceRow(walletId);
    await insertTx(pending);
    await sql.unsafe(
      `update wager_transactions
          set reference_attempts = reference_attempts + 1, next_reference_check_at = $2, updated_at = $2
        where id = $1`,
      [pending["id"], new Date(T0.getTime() + 2_000)],
    );
    await sql.unsafe(
      `update wager_transactions
          set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', next_reference_check_at = null
        where id = $1`,
      [pending["id"]],
    );
    const rows: { status: string; reference_attempts: number }[] = await sql.unsafe(
      `select status, reference_attempts from wager_transactions where id = $1`,
      [pending["id"]],
    );
    expect(rows[0]).toEqual({ status: "REJECTED", reference_attempts: 1 });
  });

  test("PENDING_REFERENCE REFUND resolved: PROCESSED + ledger + wallet in one transaction", async () => {
    const { sql, fx } = suite();
    const wallet = await fx.openWallet({ balance: "100.00" });
    const bet = await fx.move(wallet, { kind: "BET", amount: "10.00" });
    const refund = pendingReferenceRow(wallet.id, {
      reference_external_transaction_id: bet.externalId,
      observed_balance_amount: "90.00",
    });
    await insertTx(refund);
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `update wager_transactions
            set status = 'PROCESSED', reference_transaction_id = $2, processed_at = $3,
                next_reference_check_at = null, observed_balance_amount = 100.00
          where id = $1`,
        [refund["id"], bet.transactionId, T0],
      );
      await insertRow(tx, "wallet_ledger_entries", {
        id: uuid(),
        wallet_id: wallet.id,
        transaction_id: refund["id"],
        direction: "CREDIT",
        amount: "10.00",
        currency: "BRL",
        balance_before: "90.00",
        balance_after: "100.00",
        wallet_version: 3,
        created_at: T0,
      });
      await tx.unsafe(`update wallets set balance = 100.00, version = 3 where id = $1`, [
        wallet.id,
      ]);
    });
    await assertLedgerInvariant(sql, wallet.id);
  });
});
