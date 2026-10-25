import type { FailureCode } from "../domain/shared/failure-code.ts";
import type { MoneyProps } from "../domain/shared/money.ts";
import type { WagerTransactionKind } from "../domain/wager/wager-transaction-kind.ts";
import type { WagerTransactionStatus } from "../domain/wager/wager-transaction-status.ts";
import type { WagerTransaction } from "../domain/wager/wager-transaction.ts";
import type { LedgerDirection } from "../domain/wallet/ledger-direction.ts";
import type { Wallet } from "../domain/wallet/wallet.ts";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry.ts";

/** Plain JSON-ready shapes returned by the use cases: money as MoneyProps, dates as ISO-8601. */

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

/** Same shape for success, rejection and replay. */
export interface WagerTransactionResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  /** Balance observed when the outcome was decided (absent only for FAILED). */
  readonly balance?: MoneyProps;
  readonly idempotentReplay: boolean;
}

export interface TransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  readonly balance?: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly createdAt: string;
  readonly processedAt?: string;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: string;
}

export function walletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function wagerTransactionResult(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
    ...(tx.observedBalance === undefined ? {} : { balance: tx.observedBalance.toJSON() }),
    idempotentReplay,
  };
}

export function transactionView(tx: WagerTransaction): TransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
    ...(tx.observedBalance === undefined ? {} : { balance: tx.observedBalance.toJSON() }),
    ...(tx.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: tx.referenceTransactionId }),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt === undefined ? {} : { processedAt: tx.processedAt.toISOString() }),
  };
}

export function ledgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}
