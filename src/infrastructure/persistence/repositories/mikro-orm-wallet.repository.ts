import { LockMode } from "@mikro-orm/core";
import type { QueryResult } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { StaleWalletVersionError } from "../../../application/errors.ts";
import type { WalletRepository } from "../../../application/ports/repositories.ts";
import { InvalidOperationError } from "../../../domain/shared/domain-error.ts";
import type { Wallet } from "../../../domain/wallet/wallet.ts";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry.ts";
import { WalletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper.ts";
import { WalletMapper } from "../mappers/wallet.mapper.ts";
import { WalletLedgerEntryRecord } from "../models/wallet-ledger-entry.model.ts";
import { WalletRecord } from "../models/wallet.model.ts";

/**
 * Native queries only (find with disableIdentityMap, insert, nativeUpdate): the SQL order is
 * explicit, nothing is cached across statements and a uniqueness violation surfaces at the
 * statement that caused it, not at a later flush.
 */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row === null ? undefined : WalletMapper.toDomain(row);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return row === null ? undefined : WalletMapper.toDomain(row);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletRecord,
      { playerId, currency },
      { disableIdentityMap: true },
    );
    return row === null ? undefined : WalletMapper.toDomain(row);
  }

  async insertIfAbsent(wallet: Wallet): Promise<readonly WalletLedgerEntry[] | undefined> {
    // A concurrent insert of the same (player_id, currency) makes this wait on the unique index;
    // once that transaction commits, DO NOTHING returns zero rows instead of raising 23505.
    const result = await this.em
      .createQueryBuilder(WalletRecord)
      .insert(WalletMapper.toRow(wallet))
      .onConflict(["playerId", "currency"])
      .ignore()
      .execute<QueryResult>("run");
    if (result.affectedRows === 0) return undefined;
    return this.appendLedgerEntries(wallet);
  }

  async save(wallet: Wallet, expectedVersion: number): Promise<readonly WalletLedgerEntry[]> {
    const entries = await this.appendLedgerEntries(wallet);
    if (entries.length === 0) {
      throw new InvalidOperationError(`wallet ${wallet.id} has no balance change to save`);
    }
    const row = WalletMapper.toRow(wallet);
    const updated = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: row.balance, version: row.version, updatedAt: row.updatedAt },
    );
    if (updated !== 1) throw new StaleWalletVersionError(wallet.id, expectedVersion);
    return entries;
  }

  private async appendLedgerEntries(wallet: Wallet): Promise<readonly WalletLedgerEntry[]> {
    const entries = wallet.pullNewLedgerEntries();
    if (entries.length > 0) {
      await this.em.insertMany(
        WalletLedgerEntryRecord,
        entries.map((entry) => WalletLedgerEntryMapper.toRow(entry)),
      );
    }
    return entries;
  }
}
