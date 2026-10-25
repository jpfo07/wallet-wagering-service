import { Migration } from "@mikro-orm/migrations";

/**
 * Support for the outbox publisher and the PENDING_REFERENCE worker.
 *
 * - `outbox_messages.sequence`: publication order per aggregate. occurred_at cannot order events:
 *   two transactions of the same wallet on different instances are serialized by the wallet lock,
 *   but their clocks may disagree by a few ms. nextval() is not a lock, and since every transaction
 *   that writes events of a wallet holds that wallet's lock, the sequence order inside one
 *   aggregate is the commit order.
 * - `outbox_messages_pending_aggregate_idx`: the "is there an older pending event of this
 *   aggregate?" probe of the publisher.
 * - `wager_transactions_pending_by_reference_idx`: lets a transaction that has just been decided
 *   bring forward the PENDING_REFERENCE transactions waiting for it.
 */
export class Migration20261025000100_workers_schema extends Migration {
  override up(): void {
    for (const statement of UP) this.addSql(statement);
  }

  override down(): void {
    for (const statement of DOWN) this.addSql(statement);
  }
}

const UP: readonly string[] = [
  `ALTER TABLE outbox_messages ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY`,
  `ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_sequence_uq UNIQUE (sequence)`,
  `CREATE INDEX outbox_messages_pending_aggregate_idx ON outbox_messages (aggregate_id, sequence)
     WHERE published_at IS NULL`,
  `CREATE INDEX wager_transactions_pending_by_reference_idx
     ON wager_transactions (provider_id, reference_external_transaction_id)
     WHERE status = 'PENDING_REFERENCE'`,
];

const DOWN: readonly string[] = [
  `DROP INDEX wager_transactions_pending_by_reference_idx`,
  `DROP INDEX outbox_messages_pending_aggregate_idx`,
  `ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_sequence_uq`,
  `ALTER TABLE outbox_messages DROP COLUMN sequence`,
];
