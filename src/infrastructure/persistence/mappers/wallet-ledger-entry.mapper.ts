import { isLedgerDirection } from "../../../domain/wallet/ledger-direction.ts";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry.ts";
import type { WalletLedgerEntryRow } from "../models/wallet-ledger-entry.model.ts";
import { moneyFromColumns } from "./money-columns.ts";
import { PersistenceMappingError } from "./persistence-mapping.error.ts";

export const WalletLedgerEntryMapper = {
  toDomain(row: WalletLedgerEntryRow): WalletLedgerEntry {
    if (!isLedgerDirection(row.direction)) {
      throw new PersistenceMappingError(`ledger entry ${row.id}: unknown direction`);
    }
    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction,
      money: moneyFromColumns(row.amount, row.currency),
      balanceBefore: moneyFromColumns(row.balanceBefore, row.currency),
      balanceAfter: moneyFromColumns(row.balanceAfter, row.currency),
      walletVersion: row.walletVersion,
      createdAt: row.createdAt,
    });
  },

  toRow(entry: WalletLedgerEntry): WalletLedgerEntryRow {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },
};
