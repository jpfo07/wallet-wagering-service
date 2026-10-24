import type { MoneyProps } from "../shared/money.ts";
import { WagerTransactionStatus } from "../wager/wager-transaction-status.ts";
import type { WagerTransaction } from "../wager/wager-transaction.ts";
import { IntegrationEvent } from "./integration-event.ts";
import type { EventContext } from "./integration-event.ts";
import {
  assertStatus,
  required,
  wagerTransactionEventBase,
  walletEventProps,
} from "./wager-transaction-event-data.ts";
import type { WagerTransactionEventBase } from "./wager-transaction-event-data.ts";

export type WagerTransactionProcessedData = WagerTransactionEventBase & {
  readonly balance: MoneyProps;
  readonly processedAt: string;
};

/** Any applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed" as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed(
      walletEventProps(tx.walletId, ctx, {
        ...wagerTransactionEventBase(tx),
        balance: required(tx.observedBalance, "an observed balance").toJSON(),
        processedAt: required(tx.processedAt, "processedAt").toISOString(),
      }),
    );
  }
}
