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

export type WagerTransactionPendingReferenceData = WagerTransactionEventBase & {
  readonly referenceExternalTransactionId: string;
  readonly balance: MoneyProps;
  readonly referenceExpiresAt: string;
};

/** Accepted, waiting for the referenced transaction. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference" as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    return new WagerTransactionPendingReference(
      walletEventProps(tx.walletId, ctx, {
        ...wagerTransactionEventBase(tx),
        referenceExternalTransactionId: required(
          tx.referenceExternalTransactionId,
          "a referenceExternalTransactionId",
        ),
        balance: required(tx.observedBalance, "an observed balance").toJSON(),
        referenceExpiresAt: required(tx.referenceExpiresAt, "referenceExpiresAt").toISOString(),
      }),
    );
  }
}
