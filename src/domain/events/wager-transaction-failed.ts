import type { FailureCode } from "../shared/failure-code.ts";
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

export type WagerTransactionFailedData = WagerTransactionEventBase & {
  readonly failureCode: FailureCode;
};

/**
 * Permanent infrastructure failure (FAILED). Not in the minimum event list, but without it whoever
 * waits on a PENDING_REFERENCE that ends FAILED would never be told.
 */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = "WagerTransactionFailed" as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    assertStatus(tx, WagerTransactionStatus.Failed);
    return new WagerTransactionFailed(
      walletEventProps(tx.walletId, ctx, {
        ...wagerTransactionEventBase(tx),
        failureCode: required(tx.failureCode, "a failureCode"),
      }),
    );
  }
}
