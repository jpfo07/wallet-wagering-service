import type { EntityManager } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../../application/ports/repositories.ts";
import { WagerTransactionKind } from "../../../domain/wager/wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../../../domain/wager/wager-transaction-status.ts";
import type { WagerTransaction } from "../../../domain/wager/wager-transaction.ts";
import { WagerTransactionMapper } from "../mappers/wager-transaction.mapper.ts";
import { WagerTransactionRecord } from "../models/wager-transaction.model.ts";
import type { WagerTransactionRow } from "../models/wager-transaction.model.ts";

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRow(transaction));
  }

  async findProcessedDependents(referenceId: string): Promise<readonly WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { referenceTransactionId: referenceId, status: WagerTransactionStatus.Processed },
      { orderBy: { createdAt: "asc", id: "asc" }, disableIdentityMap: true },
    );
    return rows.map((row) => WagerTransactionMapper.toDomain(row));
  }

  async findProcessedRollbacksOf(
    transactionIds: readonly string[],
  ): Promise<readonly WagerTransaction[]> {
    if (transactionIds.length === 0) return [];
    const rows = await this.em.find(
      WagerTransactionRecord,
      {
        referenceTransactionId: { $in: [...transactionIds] },
        kind: WagerTransactionKind.Rollback,
        status: WagerTransactionStatus.Processed,
      },
      { orderBy: { createdAt: "asc", id: "asc" }, disableIdentityMap: true },
    );
    return rows.map((row) => WagerTransactionMapper.toDomain(row));
  }

  private async findOne(
    where: Partial<WagerTransactionRow>,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRecord, where, {
      disableIdentityMap: true,
    });
    return row === null ? undefined : WagerTransactionMapper.toDomain(row);
  }
}
