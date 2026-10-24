import { InvalidOperationError } from "../shared/domain-error.ts";
import type { MoneyProps } from "../shared/money.ts";
import type { LedgerDirection } from "../wallet/ledger-direction.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry.ts";
import { IntegrationEvent } from "./integration-event.ts";
import type { EventContext } from "./integration-event.ts";
import { walletEventProps } from "./wager-transaction-event-data.ts";

export type WalletBalanceChangedData = {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
};

/** Only when the balance changed, i.e. exactly when a ledger entry was written. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged" as const;
  readonly version = 1 as const;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidOperationError(`ledger entry ${entry.id} is not from wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged(
      walletEventProps(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
