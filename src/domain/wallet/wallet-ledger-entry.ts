import type { Money } from "../shared/money.ts";
import { LedgerDirection } from "./ledger-direction.ts";
import { InvalidLedgerEntryError } from "./wallet.errors.ts";

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Wallet version right after this entry (1 for the OPENING credit); orders the wallet's ledger. */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/** Immutable by structure: readonly fields, frozen instance, no transition methods. */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAt = new Date(state.createdAt.getTime());
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (balanceBefore.currency !== money.currency || balanceAfter.currency !== money.currency) {
      throw new InvalidLedgerEntryError("ledger entry amounts must share one currency");
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError("ledger entry amount must be positive");
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("ledger entry balances must not be negative");
    }
    if (!Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError("ledger entry walletVersion must be an integer >= 1");
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `ledger entry is not balanced: ${balanceBefore.toString()} ${props.direction} ${money.toString()} != ${balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Rebuilds persisted state; the database CHECKs already guarantee the arithmetic. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /** balanceBefore ± money === balanceAfter, according to the direction. */
  isBalanced(): boolean {
    if (
      this.balanceBefore.currency !== this.money.currency ||
      this.balanceAfter.currency !== this.money.currency
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
