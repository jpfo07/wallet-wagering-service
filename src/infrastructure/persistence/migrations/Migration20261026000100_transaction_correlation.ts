import { Migration } from "@mikro-orm/migrations";

/**
 * `wager_transactions.correlation_id`: the correlationId of the request that created the
 * transaction, so the events the PENDING_REFERENCE worker emits later keep the original
 * correlation. Tracing metadata, not a business field: it is outside the payloadHash. Nullable
 * because rows written before this migration have none (the worker then uses a fresh id).
 *
 * The guard is recreated with the column in the immutable tuple: the correlation of a transaction
 * never changes after it is inserted (a replay keeps the first request's id).
 */
export class Migration20261026000100_transaction_correlation extends Migration {
  override up(): void {
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN correlation_id varchar(128) NULL`);
    this.addSql(guard(["correlation_id"]));
  }

  override down(): void {
    this.addSql(guard([]));
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN correlation_id`);
  }
}

const IMMUTABLE_COLUMNS = [
  "id",
  "provider_id",
  "external_transaction_id",
  "idempotency_key",
  "payload_hash",
  "wallet_id",
  "player_id",
  "round_id",
  "game_id",
  "kind",
  "amount",
  "currency",
  "reference_external_transaction_id",
  "created_at",
];

/** T2 of the financial schema, with extra immutable columns. */
function guard(extraColumns: readonly string[]): string {
  const columns = [...IMMUTABLE_COLUMNS, ...extraColumns];
  const tuple = (prefix: string): string => columns.map((c) => `${prefix}.${c}`).join(", ");
  return `CREATE OR REPLACE FUNCTION wws_wager_transactions_guard() RETURNS trigger
     LANGUAGE plpgsql SET search_path = public AS $$
   BEGIN
     IF OLD.status <> 'PENDING_REFERENCE' THEN
       RAISE EXCEPTION 'transaction % is % (terminal) and cannot change', OLD.id, OLD.status
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_terminal_immutable';
     END IF;
     IF (${tuple("NEW")}) IS DISTINCT FROM (${tuple("OLD")}) THEN
       RAISE EXCEPTION 'business fields of transaction % are immutable', OLD.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_business_fields_immutable';
     END IF;
     RETURN NEW;
   END $$`;
}
