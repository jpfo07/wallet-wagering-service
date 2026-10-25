import { Money } from "../shared/money.ts";
import { CurrencyMismatchError } from "../shared/money.errors.ts";
import { LedgerDirection } from "./ledger-direction.ts";
import { WalletLedgerEntry } from "./wallet-ledger-entry.ts";
import {
  DuplicateLedgerMovementError,
  InsufficientBalanceError,
  InvalidLedgerEntryError,
  InvalidWalletError,
} from "./wallet.errors.ts";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  /** Required when initialBalance > 0: ids of the OPENING transaction and its CREDIT entry. */
  readonly opening?: { readonly transactionId: string; readonly ledgerEntryId: string } | undefined;
}

export interface WalletMovement {
  readonly transactionId: string;
  readonly money: Money;
  readonly ledgerEntryId: string;
  readonly at: Date;
}

/**
 * Aggregate root. The balance only changes through debit/credit (and the opening credit), and each
 * change produces its ledger entry in the same step: the entry is validated first, then balance,
 * version and updatedAt change together. If anything throws, the wallet is left untouched.
 */
export class Wallet {
  private readonly newLedgerEntries: WalletLedgerEntry[] = [];
  private readonly movedTransactionIds = new Set<string>();

  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** version = 1 right after creation, including the opening credit (it is part of creation). */
  static open(props: OpenWalletProps): Wallet {
    const { id, playerId, initialBalance, at, opening } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError("initial balance must not be negative");
    }
    if (initialBalance.isPositive() && opening === undefined) {
      throw new InvalidWalletError("a positive initial balance requires an OPENING transaction");
    }
    if (initialBalance.isZero() && opening !== undefined) {
      throw new InvalidWalletError("a zero initial balance has no OPENING transaction");
    }
    const wallet = new Wallet(
      id,
      playerId,
      initialBalance.currency,
      Money.zero(initialBalance.currency),
      1,
      at,
      at,
    );
    if (opening !== undefined) {
      wallet.move(
        LedgerDirection.Credit,
        { ...opening, money: initialBalance, at },
        { bumpVersion: false },
      );
    }
    return wallet;
  }

  /** Rebuilds persisted state; does not revalidate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, movement, { bumpVersion: true });
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, movement, { bumpVersion: true });
  }

  /** Entries created since the last call; the repository persists them with the wallet. */
  pullNewLedgerEntries(): readonly WalletLedgerEntry[] {
    return this.newLedgerEntries.splice(0);
  }

  private move(
    direction: LedgerDirection,
    movement: WalletMovement,
    options: { bumpVersion: boolean },
  ): WalletLedgerEntry {
    const { transactionId, money, ledgerEntryId, at } = movement;
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError("movement amount must be positive");
    }
    if (this.movedTransactionIds.has(transactionId)) {
      throw new DuplicateLedgerMovementError(this.id, transactionId);
    }
    if (direction === LedgerDirection.Debit && this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError(this.id);
    }

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money);
    const versionAfter = options.bumpVersion ? this._version + 1 : this._version;
    const entry = WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: versionAfter,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version = versionAfter;
    this._updatedAt = at;
    this.newLedgerEntries.push(entry);
    this.movedTransactionIds.add(transactionId);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
