import { Migration } from "@mikro-orm/migrations";

/**
 * Financial schema: wallets, wager_transactions and the append-only ledger.
 *
 * Every guarantee that must hold even with buggy code or several instances lives here, in SQL:
 * uniqueness, immutability, non-negativity and wallet balance == ledger. Trigger errors use
 * SQLSTATE 23514 (check_violation) plus a constraint name, so they are classified as permanent
 * integrity errors (never retried) and tests can assert exactly which guard refused the write.
 *
 * Foreign keys and T5–T7 are DEFERRABLE INITIALLY DEFERRED: they run at COMMIT, when wallet,
 * transaction and ledger rows are all written, so correctness does not depend on the ORM's flush
 * order (persistence models have no relations, so the ORM does not order inserts by FK). Unique
 * constraints stay immediate: duplicates are detected at the statement that causes them.
 */
export class Migration20261024000100_financial_schema extends Migration {
  override up(): void {
    for (const statement of UP) this.addSql(statement);
  }

  override down(): void {
    for (const statement of DOWN) this.addSql(statement);
  }
}

const TEXT_255 = (column: string): string =>
  `(${column} ~ '\\S' AND char_length(${column}) <= 255)`;

const UP: readonly string[] = [
  // ---------------------------------------------------------------- wallets
  `CREATE TABLE wallets (
    id          uuid           NOT NULL,
    player_id   uuid           NOT NULL,
    currency    char(3)        NOT NULL,
    balance     numeric(20,2)  NOT NULL,
    version     integer        NOT NULL,
    created_at  timestamptz(3) NOT NULL,
    updated_at  timestamptz(3) NOT NULL,
    CONSTRAINT wallets_pk                       PRIMARY KEY (id),
    CONSTRAINT wallets_player_currency_uq       UNIQUE (player_id, currency),
    CONSTRAINT wallets_id_currency_uq           UNIQUE (id, currency),
    CONSTRAINT wallets_balance_non_negative_chk CHECK (balance >= 0),
    CONSTRAINT wallets_version_min_chk          CHECK (version >= 1),
    CONSTRAINT wallets_currency_format_chk      CHECK (currency ~ '^[A-Z]{3}$')
  )`,

  // ---------------------------------------------------------------- wager_transactions
  `CREATE TABLE wager_transactions (
    id                                uuid           NOT NULL,
    provider_id                       text           NOT NULL,
    external_transaction_id           text           NOT NULL,
    idempotency_key                   text           NOT NULL,
    payload_hash                      char(64)       NOT NULL,
    wallet_id                         uuid           NOT NULL,
    player_id                         uuid           NOT NULL,
    round_id                          text           NOT NULL,
    game_id                           text           NOT NULL,
    kind                              text           NOT NULL,
    amount                            numeric(20,2)  NOT NULL,
    currency                          char(3)        NOT NULL,
    reference_external_transaction_id text           NULL,
    reference_transaction_id          uuid           NULL,
    status                            text           NOT NULL,
    failure_code                      text           NULL,
    processed_at                      timestamptz(3) NULL,
    observed_balance_amount           numeric(20,2)  NULL,
    observed_balance_currency         char(3)        NULL,
    reference_attempts                integer        NOT NULL,
    next_reference_check_at           timestamptz(3) NULL,
    reference_expires_at              timestamptz(3) NULL,
    created_at                        timestamptz(3) NOT NULL,
    updated_at                        timestamptz(3) NOT NULL,

    CONSTRAINT wager_transactions_pk                         PRIMARY KEY (id),
    CONSTRAINT wager_transactions_provider_idempotency_key_uq UNIQUE (provider_id, idempotency_key),
    CONSTRAINT wager_transactions_provider_external_uq       UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT wager_transactions_ledger_target_uq           UNIQUE (id, wallet_id, currency, amount),
    CONSTRAINT wager_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT wager_transactions_observed_currency_fk FOREIGN KEY (wallet_id, observed_balance_currency)
      REFERENCES wallets (id, currency) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT wager_transactions_reference_fk FOREIGN KEY (reference_transaction_id)
      REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,

    CONSTRAINT wager_transactions_kind_chk
      CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
    CONSTRAINT wager_transactions_status_chk
      CHECK (status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
    CONSTRAINT wager_transactions_failure_code_chk CHECK (failure_code IS NULL OR failure_code IN (
      'INSUFFICIENT_FUNDS','REVERSAL_WOULD_OVERDRAW','REFERENCE_NOT_FOUND','REFERENCE_ALREADY_REVERSED',
      'REFERENCE_HAS_ACTIVE_SETTLEMENT','REFERENCE_KIND_NOT_ALLOWED','REFERENCE_MISMATCH',
      'REFERENCE_NOT_PROCESSED','AMOUNT_MISMATCH','CURRENCY_MISMATCH','WALLET_PLAYER_MISMATCH',
      'INTERNAL_PERMANENT_ERROR')),
    CONSTRAINT wager_transactions_currency_format_chk CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT wager_transactions_payload_hash_chk CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT wager_transactions_text_fields_chk CHECK (
          ${TEXT_255("provider_id")}
      AND ${TEXT_255("external_transaction_id")}
      AND ${TEXT_255("idempotency_key")}
      AND ${TEXT_255("round_id")}
      AND ${TEXT_255("game_id")}
      AND (reference_external_transaction_id IS NULL OR ${TEXT_255("reference_external_transaction_id")})),

    CONSTRAINT wager_transactions_amount_chk CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
    CONSTRAINT wager_transactions_observed_balance_chk CHECK (
          (observed_balance_amount IS NULL) = (observed_balance_currency IS NULL)
      AND (observed_balance_amount IS NULL OR observed_balance_amount >= 0)),
    CONSTRAINT wager_transactions_reference_attempts_chk CHECK (reference_attempts >= 0),

    CONSTRAINT wager_transactions_reference_by_kind_chk CHECK (CASE
      WHEN kind IN ('REFUND','ROLLBACK') THEN reference_external_transaction_id IS NOT NULL
      WHEN kind IN ('BET','OPENING') THEN reference_external_transaction_id IS NULL
                                      AND reference_transaction_id IS NULL
      ELSE true END),
    CONSTRAINT wager_transactions_no_self_reference_chk CHECK (
          reference_external_transaction_id IS DISTINCT FROM external_transaction_id
      AND reference_transaction_id IS DISTINCT FROM id),
    CONSTRAINT wager_transactions_opening_internal_chk
      CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
    CONSTRAINT wager_transactions_opening_processed_chk
      CHECK (kind <> 'OPENING' OR status = 'PROCESSED'),

    CONSTRAINT wager_transactions_processed_state_chk CHECK (status <> 'PROCESSED' OR (
          processed_at IS NOT NULL AND failure_code IS NULL AND observed_balance_amount IS NOT NULL
      AND (reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL))),
    CONSTRAINT wager_transactions_rejected_state_chk CHECK (status <> 'REJECTED' OR (
          failure_code IS NOT NULL AND failure_code <> 'INTERNAL_PERMANENT_ERROR'
      AND processed_at IS NULL AND observed_balance_amount IS NOT NULL)),
    CONSTRAINT wager_transactions_failed_state_chk CHECK (status <> 'FAILED' OR (
          failure_code = 'INTERNAL_PERMANENT_ERROR' AND processed_at IS NULL)),
    CONSTRAINT wager_transactions_pending_reference_state_chk CHECK (status <> 'PENDING_REFERENCE' OR (
          reference_external_transaction_id IS NOT NULL AND reference_transaction_id IS NULL
      AND failure_code IS NULL AND processed_at IS NULL
      AND observed_balance_amount IS NOT NULL AND reference_expires_at IS NOT NULL)),
    CONSTRAINT wager_transactions_next_check_chk CHECK (
          (status = 'PENDING_REFERENCE') = (next_reference_check_at IS NOT NULL))
  )`,

  // At most one PROCESSED reversal (REFUND or ROLLBACK) per referenced transaction.
  `CREATE UNIQUE INDEX wager_transactions_single_reversal_uq ON wager_transactions (reference_transaction_id)
     WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`,
  // Dependents of a reference and their ROLLBACKs (ReferenceState).
  `CREATE INDEX wager_transactions_reference_idx ON wager_transactions (reference_transaction_id)
     WHERE reference_transaction_id IS NOT NULL`,
  // Due queue of the PENDING_REFERENCE worker.
  `CREATE INDEX wager_transactions_pending_due_idx ON wager_transactions (next_reference_check_at)
     WHERE status = 'PENDING_REFERENCE'`,

  // ---------------------------------------------------------------- wallet_ledger_entries
  // (wallet_id, wallet_version) is unique and strictly increasing per wallet: it orders the ledger
  // and is the stable cursor of GET /wallets/:id/ledger (immune to clock skew between instances).
  `CREATE TABLE wallet_ledger_entries (
    id              uuid           NOT NULL,
    wallet_id       uuid           NOT NULL,
    transaction_id  uuid           NOT NULL,
    direction       text           NOT NULL,
    amount          numeric(20,2)  NOT NULL,
    currency        char(3)        NOT NULL,
    balance_before  numeric(20,2)  NOT NULL,
    balance_after   numeric(20,2)  NOT NULL,
    wallet_version  integer        NOT NULL,
    created_at      timestamptz(3) NOT NULL,
    CONSTRAINT wallet_ledger_entries_pk                PRIMARY KEY (id),
    CONSTRAINT wallet_ledger_entries_transaction_uq    UNIQUE (transaction_id, wallet_id),
    CONSTRAINT wallet_ledger_entries_wallet_version_uq UNIQUE (wallet_id, wallet_version),
    CONSTRAINT wallet_ledger_entries_wallet_fk FOREIGN KEY (wallet_id, currency)
      REFERENCES wallets (id, currency) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT wallet_ledger_entries_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency, amount)
      REFERENCES wager_transactions (id, wallet_id, currency, amount) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT wallet_ledger_entries_amount_positive_chk CHECK (amount > 0),
    CONSTRAINT wallet_ledger_entries_balances_non_negative_chk
      CHECK (balance_before >= 0 AND balance_after >= 0),
    -- Also restricts direction to DEBIT/CREDIT: any other value satisfies neither branch.
    CONSTRAINT wallet_ledger_entries_arithmetic_chk CHECK (
      (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
      (direction = 'DEBIT'  AND balance_after = balance_before - amount)),
    CONSTRAINT wallet_ledger_entries_wallet_version_chk CHECK (wallet_version >= 1),
    CONSTRAINT wallet_ledger_entries_currency_format_chk CHECK (currency ~ '^[A-Z]{3}$')
  )`,

  // ---------------------------------------------------------------- functions
  // Generic "this operation is forbidden" guard; TG_ARGV[0] is the reported constraint name.
  `CREATE FUNCTION wws_forbid_mutation() RETURNS trigger
     LANGUAGE plpgsql SET search_path = public AS $$
   BEGIN
     RAISE EXCEPTION '% on % is forbidden', TG_OP, TG_TABLE_NAME
       USING ERRCODE = 'check_violation', CONSTRAINT = TG_ARGV[0];
   END $$`,

  // T2: terminal transactions never change; business fields never change.
  `CREATE FUNCTION wws_wager_transactions_guard() RETURNS trigger
     LANGUAGE plpgsql SET search_path = public AS $$
   BEGIN
     IF OLD.status <> 'PENDING_REFERENCE' THEN
       RAISE EXCEPTION 'transaction % is % (terminal) and cannot change', OLD.id, OLD.status
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_terminal_immutable';
     END IF;
     IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
         NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
         NEW.reference_external_transaction_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
         OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
         OLD.reference_external_transaction_id, OLD.created_at) THEN
       RAISE EXCEPTION 'business fields of transaction % are immutable', OLD.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_business_fields_immutable';
     END IF;
     RETURN NEW;
   END $$`,

  // T3: version starts at 1 and moves by exactly 1 per balance change; identity never changes.
  `CREATE FUNCTION wws_wallets_guard() RETURNS trigger
     LANGUAGE plpgsql SET search_path = public AS $$
   BEGIN
     IF TG_OP = 'INSERT' THEN
       IF NEW.version <> 1 THEN
         RAISE EXCEPTION 'wallet % must be created with version 1 (got %)', NEW.id, NEW.version
           USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_initial_version';
       END IF;
       RETURN NEW;
     END IF;
     IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
       RAISE EXCEPTION 'identity of wallet % is immutable', OLD.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_identity_immutable';
     END IF;
     IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
       RAISE EXCEPTION 'wallet % balance changed: version must go from % to %, got %',
         OLD.id, OLD.version, OLD.version + 1, NEW.version
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_version_rule';
     END IF;
     IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
       RAISE EXCEPTION 'wallet % version changed without a balance change', OLD.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_version_rule';
     END IF;
     RETURN NEW;
   END $$`,

  // T4: the ledger is a continuous chain per wallet. Locking the wallet row first serializes
  // concurrent writers of one wallet even if the application forgot its own lock; afterwards each
  // statement of this (volatile) function sees what the previous lock holder committed.
  `CREATE FUNCTION wws_ledger_chain() RETURNS trigger
     LANGUAGE plpgsql SET search_path = public AS $$
   DECLARE
     last_entry record;
   BEGIN
     PERFORM 1 FROM wallets WHERE id = NEW.wallet_id FOR NO KEY UPDATE;
     SELECT balance_after, wallet_version INTO last_entry
       FROM wallet_ledger_entries
      WHERE wallet_id = NEW.wallet_id
      ORDER BY wallet_version DESC
      LIMIT 1;
     IF NOT FOUND THEN
       IF NEW.balance_before <> 0 THEN
         RAISE EXCEPTION 'first ledger entry of wallet % must start at 0.00, got %',
           NEW.wallet_id, NEW.balance_before
           USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_chain';
       END IF;
     ELSE
       IF NEW.balance_before <> last_entry.balance_after THEN
         RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before % <> previous balance_after %',
           NEW.wallet_id, NEW.balance_before, last_entry.balance_after
           USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_chain';
       END IF;
       IF NEW.wallet_version <= last_entry.wallet_version THEN
         RAISE EXCEPTION 'ledger chain broken for wallet %: wallet_version % <= previous %',
           NEW.wallet_id, NEW.wallet_version, last_entry.wallet_version
           USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_chain';
       END IF;
     END IF;
     RETURN NEW;
   END $$`,

  // wallet.balance/version == last ledger entry (or 0.00/1 when the wallet has no entry).
  `CREATE FUNCTION wws_assert_wallet_matches_ledger(p_wallet_id uuid) RETURNS void
     LANGUAGE plpgsql SET search_path = public AS $$
   DECLARE
     w record;
     last_entry record;
   BEGIN
     SELECT balance, version INTO w FROM wallets WHERE id = p_wallet_id;
     IF NOT FOUND THEN
       RETURN;
     END IF;
     SELECT balance_after, wallet_version INTO last_entry
       FROM wallet_ledger_entries
      WHERE wallet_id = p_wallet_id
      ORDER BY wallet_version DESC
      LIMIT 1;
     IF NOT FOUND THEN
       IF w.balance <> 0 OR w.version <> 1 THEN
         RAISE EXCEPTION 'wallet % has balance % / version % but no ledger entry', p_wallet_id, w.balance, w.version
           USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_matches_ledger';
       END IF;
     ELSIF w.balance <> last_entry.balance_after OR w.version <> last_entry.wallet_version THEN
       RAISE EXCEPTION 'wallet % has balance % / version %, ledger says % / %',
         p_wallet_id, w.balance, w.version, last_entry.balance_after, last_entry.wallet_version
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_matches_ledger';
     END IF;
   END $$`,

  // T6 (deferred).
  `CREATE FUNCTION wws_wallet_matches_ledger() RETURNS trigger
     LANGUAGE plpgsql SET search_path = public AS $$
   BEGIN
     PERFORM wws_assert_wallet_matches_ledger(NEW.id);
     RETURN NULL;
   END $$`,

  // T5 (deferred): an entry only exists for a PROCESSED, balance-moving transaction, in the
  // direction its kind implies (mirrors WagerTransaction.ledgerDirectionFor), and leaves the wallet
  // matching its ledger.
  `CREATE FUNCTION wws_ledger_entry_matches_transaction() RETURNS trigger
     LANGUAGE plpgsql SET search_path = public AS $$
   DECLARE
     tx record;
     reference_direction text;
     expected text;
   BEGIN
     SELECT status, kind, reference_transaction_id INTO tx
       FROM wager_transactions WHERE id = NEW.transaction_id;
     IF NOT FOUND THEN
       RETURN NULL; -- wallet_ledger_entries_transaction_fk reports it
     END IF;
     IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' THEN
       RAISE EXCEPTION 'ledger entry % belongs to a % % transaction: only PROCESSED, non-LOSS transactions move the balance',
         NEW.id, tx.status, tx.kind
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_matches_transaction';
     END IF;
     IF tx.kind = 'ROLLBACK' THEN
       SELECT direction INTO reference_direction
         FROM wallet_ledger_entries WHERE transaction_id = tx.reference_transaction_id;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'ROLLBACK % reverses a transaction without a ledger entry', NEW.transaction_id
           USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_matches_transaction';
       END IF;
       expected := CASE reference_direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END;
     ELSE
       expected := CASE tx.kind WHEN 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
     END IF;
     IF NEW.direction <> expected THEN
       RAISE EXCEPTION 'ledger entry % of a % must be %, got %', NEW.id, tx.kind, expected, NEW.direction
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_matches_transaction';
     END IF;
     PERFORM wws_assert_wallet_matches_ledger(NEW.wallet_id);
     RETURN NULL;
   END $$`,

  // T7 (deferred): a PROCESSED, balance-moving transaction has its ledger entry.
  `CREATE FUNCTION wws_processed_transaction_has_entry() RETURNS trigger
     LANGUAGE plpgsql SET search_path = public AS $$
   BEGIN
     PERFORM 1 FROM wallet_ledger_entries WHERE transaction_id = NEW.id;
     IF NOT FOUND THEN
       RAISE EXCEPTION 'PROCESSED % transaction % has no ledger entry', NEW.kind, NEW.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_processed_has_entry';
     END IF;
     RETURN NULL;
   END $$`,

  // ---------------------------------------------------------------- triggers
  // T1: ledger is append-only.
  `CREATE TRIGGER wallet_ledger_entries_append_only
     BEFORE UPDATE OR DELETE ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION wws_forbid_mutation('wallet_ledger_entries_append_only')`,
  `CREATE TRIGGER wallet_ledger_entries_no_truncate
     BEFORE TRUNCATE ON wallet_ledger_entries
     FOR EACH STATEMENT EXECUTE FUNCTION wws_forbid_mutation('wallet_ledger_entries_append_only')`,
  // T4
  `CREATE TRIGGER wallet_ledger_entries_chain
     BEFORE INSERT ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION wws_ledger_chain()`,
  // T5
  `CREATE CONSTRAINT TRIGGER wallet_ledger_entries_matches_transaction
     AFTER INSERT ON wallet_ledger_entries
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION wws_ledger_entry_matches_transaction()`,

  // T2
  `CREATE TRIGGER wager_transactions_guard
     BEFORE UPDATE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION wws_wager_transactions_guard()`,
  `CREATE TRIGGER wager_transactions_no_delete
     BEFORE DELETE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION wws_forbid_mutation('wager_transactions_no_delete')`,
  `CREATE TRIGGER wager_transactions_no_truncate
     BEFORE TRUNCATE ON wager_transactions
     FOR EACH STATEMENT EXECUTE FUNCTION wws_forbid_mutation('wager_transactions_no_delete')`,
  // T7
  `CREATE CONSTRAINT TRIGGER wager_transactions_processed_has_entry
     AFTER INSERT OR UPDATE ON wager_transactions
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW WHEN (NEW.status = 'PROCESSED' AND NEW.kind <> 'LOSS')
     EXECUTE FUNCTION wws_processed_transaction_has_entry()`,

  // T3
  `CREATE TRIGGER wallets_guard
     BEFORE INSERT OR UPDATE ON wallets
     FOR EACH ROW EXECUTE FUNCTION wws_wallets_guard()`,
  `CREATE TRIGGER wallets_no_delete
     BEFORE DELETE ON wallets
     FOR EACH ROW EXECUTE FUNCTION wws_forbid_mutation('wallets_no_delete')`,
  `CREATE TRIGGER wallets_no_truncate
     BEFORE TRUNCATE ON wallets
     FOR EACH STATEMENT EXECUTE FUNCTION wws_forbid_mutation('wallets_no_delete')`,
  // T6
  `CREATE CONSTRAINT TRIGGER wallets_matches_ledger
     AFTER INSERT OR UPDATE ON wallets
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION wws_wallet_matches_ledger()`,
];

// Reverse order, no CASCADE: a forgotten dependency makes the down fail loudly instead of
// silently dropping more than intended. Dropping a table drops its own triggers and indexes.
const DOWN: readonly string[] = [
  `DROP TABLE wallet_ledger_entries`,
  `DROP TABLE wager_transactions`,
  `DROP TABLE wallets`,
  `DROP FUNCTION wws_processed_transaction_has_entry()`,
  `DROP FUNCTION wws_ledger_entry_matches_transaction()`,
  `DROP FUNCTION wws_wallet_matches_ledger()`,
  `DROP FUNCTION wws_assert_wallet_matches_ledger(uuid)`,
  `DROP FUNCTION wws_ledger_chain()`,
  `DROP FUNCTION wws_wallets_guard()`,
  `DROP FUNCTION wws_wager_transactions_guard()`,
  `DROP FUNCTION wws_forbid_mutation()`,
];
