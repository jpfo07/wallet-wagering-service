import { Wallet } from "../../../domain/wallet/wallet.ts";
import type { WalletRow } from "../models/wallet.model.ts";
import { moneyFromColumns } from "./money-columns.ts";

export const WalletMapper = {
  toDomain(row: WalletRow): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: moneyFromColumns(row.balance, row.currency),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  toRow(wallet: Wallet): WalletRow {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },
};
