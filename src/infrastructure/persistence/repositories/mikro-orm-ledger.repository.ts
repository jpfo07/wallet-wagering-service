import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  LedgerRepository,
  ReconciliationSnapshot,
} from "../../../application/ports/repositories.ts";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry.ts";
import { moneyFromColumns } from "../mappers/money-columns.ts";
import { PersistenceMappingError } from "../mappers/persistence-mapping.error.ts";
import { WalletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper.ts";
import { WalletLedgerEntryRecord } from "../models/wallet-ledger-entry.model.ts";

interface SnapshotRow {
  readonly stored_balance: string;
  readonly currency: string;
  readonly credits: string;
  readonly debits: string;
  readonly checked_entries: number;
}

// One statement, one snapshot: in READ COMMITTED two separate SELECTs could straddle a commit and
// report a divergence that never existed. Sums stay numeric and come back as text (never number);
// credits and debits are summed apart so each is a non-negative amount that Money accepts.
const SNAPSHOT_SQL = `
  select w.balance::text as stored_balance,
         w.currency as currency,
         coalesce(sum(e.amount) filter (where e.direction = 'CREDIT'), 0)::numeric(20,2)::text as credits,
         coalesce(sum(e.amount) filter (where e.direction = 'DEBIT'), 0)::numeric(20,2)::text as debits,
         count(e.id)::int as checked_entries
    from wallets w
    left join wallet_ledger_entries e on e.wallet_id = w.id
   where w.id = ?
   group by w.id, w.balance, w.currency`;

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async page(
    walletId: string,
    options: { readonly afterVersion: number | undefined; readonly limit: number },
  ): Promise<readonly WalletLedgerEntry[]> {
    const rows = await this.em.find(
      WalletLedgerEntryRecord,
      options.afterVersion === undefined
        ? { walletId }
        : { walletId, walletVersion: { $gt: options.afterVersion } },
      { orderBy: { walletVersion: "asc" }, limit: options.limit, disableIdentityMap: true },
    );
    return rows.map((row) => WalletLedgerEntryMapper.toDomain(row));
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    const rows = await this.em.execute<SnapshotRow[]>(SNAPSHOT_SQL, [walletId]);
    const row = rows[0];
    if (row === undefined) return undefined;
    if (!Number.isSafeInteger(row.checked_entries)) {
      throw new PersistenceMappingError(`wallet ${walletId}: invalid ledger entry count`);
    }
    const credits = moneyFromColumns(row.credits, row.currency);
    const debits = moneyFromColumns(row.debits, row.currency);
    return {
      storedBalance: moneyFromColumns(row.stored_balance, row.currency),
      calculatedBalance: credits.subtract(debits),
      checkedEntries: row.checked_entries,
    };
  }
}
