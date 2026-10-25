import { defineEntity, p } from "@mikro-orm/postgresql";
import type { InferEntity } from "@mikro-orm/postgresql";

/**
 * Persistence record of a WagerTransaction. Plain scalar columns only: foreign keys, CHECKs and
 * triggers live in the SQL migrations, and the ORM never loads relations.
 */
export const WagerTransactionRecord = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.character().length(64),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: p.decimal("string").precision(20).scale(2),
    currency: p.character().length(3),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    processedAt: p.datetime(3).nullable(),
    observedBalanceAmount: p.decimal("string").precision(20).scale(2).nullable(),
    observedBalanceCurrency: p.character().length(3).nullable(),
    referenceAttempts: p.integer(),
    nextReferenceCheckAt: p.datetime(3).nullable(),
    referenceExpiresAt: p.datetime(3).nullable(),
    createdAt: p.datetime(3),
    updatedAt: p.datetime(3),
  },
});

export type WagerTransactionRow = InferEntity<typeof WagerTransactionRecord>;
