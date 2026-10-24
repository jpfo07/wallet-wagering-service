import { InvalidOperationError } from "../shared/domain-error.ts";
import type { MoneyProps } from "../shared/money.ts";
import type { WagerTransactionKind } from "../wager/wager-transaction-kind.ts";
import type { WagerTransactionStatus } from "../wager/wager-transaction-status.ts";
import type { WagerTransaction } from "../wager/wager-transaction.ts";
import type { EventContext, IntegrationEventProps } from "./integration-event.ts";

/** Fields shared by every WagerTransaction* event. */
export type WagerTransactionEventBase = {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
};

export function wagerTransactionEventBase(tx: WagerTransaction): WagerTransactionEventBase {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: tx.referenceTransactionId }),
  };
}

/** aggregateId is the walletId for every event: it becomes the FIFO MessageGroupId. */
export function walletEventProps<T>(
  walletId: string,
  ctx: EventContext,
  data: T,
): IntegrationEventProps<T> {
  return { ...ctx, aggregateId: walletId, data };
}

export function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvalidOperationError(
      `event requires transaction ${tx.id} to be ${expected}, but it is ${tx.status}`,
    );
  }
}

export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new InvalidOperationError(`event requires ${what}`);
  }
  return value;
}
