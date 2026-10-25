import { isFailureCode } from "../../../domain/shared/failure-code.ts";
import type { FailureCode } from "../../../domain/shared/failure-code.ts";
import { isWagerTransactionKind } from "../../../domain/wager/wager-transaction-kind.ts";
import { isWagerTransactionStatus } from "../../../domain/wager/wager-transaction-status.ts";
import { WagerTransaction } from "../../../domain/wager/wager-transaction.ts";
import type { WagerTransactionRow } from "../models/wager-transaction.model.ts";
import { moneyFromColumns, optionalMoneyFromColumns } from "./money-columns.ts";
import { PersistenceMappingError } from "./persistence-mapping.error.ts";

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export const WagerTransactionMapper = {
  toDomain(row: WagerTransactionRow): WagerTransaction {
    const { kind, status } = row;
    if (!isWagerTransactionKind(kind)) {
      throw new PersistenceMappingError(`transaction ${row.id}: unknown kind`);
    }
    if (!isWagerTransactionStatus(status)) {
      throw new PersistenceMappingError(`transaction ${row.id}: unknown status`);
    }
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind,
      money: moneyFromColumns(row.amount, row.currency),
      referenceExternalTransactionId: orUndefined(row.referenceExternalTransactionId),
      createdAt: row.createdAt,
      status,
      referenceTransactionId: orUndefined(row.referenceTransactionId),
      failureCode: failureCodeOf(row),
      processedAt: orUndefined(row.processedAt),
      observedBalance: optionalMoneyFromColumns(
        row.observedBalanceAmount,
        row.observedBalanceCurrency,
      ),
      referenceAttempts: row.referenceAttempts,
      nextReferenceCheckAt: orUndefined(row.nextReferenceCheckAt),
      referenceExpiresAt: orUndefined(row.referenceExpiresAt),
      updatedAt: row.updatedAt,
    });
  },

  toRow(tx: WagerTransaction): WagerTransactionRow {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      processedAt: tx.processedAt ?? null,
      observedBalanceAmount: tx.observedBalance?.amount ?? null,
      observedBalanceCurrency: tx.observedBalance?.currency ?? null,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
      referenceExpiresAt: tx.referenceExpiresAt ?? null,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  },
};

function failureCodeOf(row: WagerTransactionRow): FailureCode | undefined {
  const code = row.failureCode;
  if (code == null) return undefined;
  if (!isFailureCode(code)) {
    throw new PersistenceMappingError(`transaction ${row.id}: unknown failure code`);
  }
  return code;
}
