import type { EntityManager } from "@mikro-orm/postgresql";
import { StalePendingTransactionError } from "../../../application/errors.ts";
import type {
  PendingReferenceCandidate,
  WagerTransactionRepository,
} from "../../../application/ports/repositories.ts";
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

  async findDuePendingReferences(
    now: Date,
    limit: number,
  ): Promise<readonly PendingReferenceCandidate[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceCheckAt: { $lte: now } },
      {
        fields: ["id", "walletId"],
        orderBy: { nextReferenceCheckAt: "asc", id: "asc" },
        limit,
        disableIdentityMap: true,
      },
    );
    return rows.map((row) => ({ transactionId: row.id, walletId: row.walletId }));
  }

  async updatePending(
    transaction: WagerTransaction,
    expectedReferenceAttempts: number,
  ): Promise<void> {
    const row = WagerTransactionMapper.toRow(transaction);
    // Only the columns a re-check can change; the business fields are immutable (trigger).
    const updated = await this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        id: transaction.id,
        status: WagerTransactionStatus.PendingReference,
        referenceAttempts: expectedReferenceAttempts,
      },
      {
        status: row.status,
        failureCode: row.failureCode,
        referenceTransactionId: row.referenceTransactionId,
        processedAt: row.processedAt,
        observedBalanceAmount: row.observedBalanceAmount,
        observedBalanceCurrency: row.observedBalanceCurrency,
        referenceAttempts: row.referenceAttempts,
        nextReferenceCheckAt: row.nextReferenceCheckAt,
        referenceExpiresAt: row.referenceExpiresAt,
        updatedAt: row.updatedAt,
      },
    );
    if (updated !== 1) {
      throw new StalePendingTransactionError(transaction.id, expectedReferenceAttempts);
    }
  }

  async expediteReferenceChecks(props: {
    readonly walletId: string;
    readonly providerId: string;
    readonly referenceExternalTransactionId: string;
    readonly at: Date;
  }): Promise<number> {
    // Same wallet only: the caller holds this wallet's lock, so the rows locked here are never
    // wanted by a transaction holding another wallet's lock (no lock cycle). A dependent on another
    // wallet would be rejected for REFERENCE_MISMATCH anyway; it just waits for its own backoff.
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId: props.providerId,
        referenceExternalTransactionId: props.referenceExternalTransactionId,
        walletId: props.walletId,
        nextReferenceCheckAt: { $gt: props.at },
      },
      { nextReferenceCheckAt: props.at },
    );
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
