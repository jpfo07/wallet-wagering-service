import { defineEntity, p } from "@mikro-orm/postgresql";
import type { InferEntity } from "@mikro-orm/postgresql";

/** Persistence record of a WalletLedgerEntry (append-only: the database forbids UPDATE/DELETE). */
export const WalletLedgerEntryRecord = defineEntity({
  name: "WalletLedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.text(),
    amount: p.decimal("string").precision(20).scale(2),
    currency: p.character().length(3),
    balanceBefore: p.decimal("string").precision(20).scale(2),
    balanceAfter: p.decimal("string").precision(20).scale(2),
    walletVersion: p.integer(),
    createdAt: p.datetime(3),
  },
});

export type WalletLedgerEntryRow = InferEntity<typeof WalletLedgerEntryRecord>;
