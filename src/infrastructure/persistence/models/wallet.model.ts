import { defineEntity, p } from "@mikro-orm/postgresql";
import type { InferEntity } from "@mikro-orm/postgresql";

/** Persistence record of a Wallet. Money columns are strings end to end (never `number`). */
export const WalletRecord = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.character().length(3),
    balance: p.decimal("string").precision(20).scale(2),
    version: p.integer(),
    createdAt: p.datetime(3),
    updatedAt: p.datetime(3),
  },
});

export type WalletRow = InferEntity<typeof WalletRecord>;
