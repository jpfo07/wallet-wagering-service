import type { FailureCode } from "../shared/failure-code.ts";
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

export type WagerTransactionRejectedData = WagerTransactionEventBase & {
  readonly failureCode: FailureCode;
  readonly balance: MoneyProps;
};

/** Rejected by a business rule. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected" as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected(
      walletEventProps(tx.walletId, ctx, {
        ...wagerTransactionEventBase(tx),
        failureCode: required(tx.failureCode, "a failureCode"),
        balance: required(tx.observedBalance, "an observed balance").toJSON(),
      }),
    );
  }
}
