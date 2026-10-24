import { computeWagerPayloadHash } from "../../src/domain/idempotency/payload-hash.ts";
import { ExponentialBackoff, addMilliseconds } from "../../src/domain/shared/backoff-policy.ts";
import { Money } from "../../src/domain/shared/money.ts";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction.ts";
import { Wallet } from "../../src/domain/wallet/wallet.ts";
import type { WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry.ts";
import { ReferenceState } from "../../src/domain/wager/reference-state.ts";
import { settleWager } from "../../src/domain/wager/wager-settlement.ts";
import type {
  ReferenceRetryPolicy,
  SettlementOutcome,
} from "../../src/domain/wager/wager-settlement.ts";
import { WagerTransactionKind } from "../../src/domain/wager/wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../../src/domain/wager/wager-transaction-status.ts";
import { WagerTransaction } from "../../src/domain/wager/wager-transaction.ts";

export const T0 = new Date("2026-07-29T15:00:00.000Z");
export const PROVIDER = "provider-a";
export const PLAYER = "player-1";
export const WALLET = "wallet-1";
export const ROUND = "round-1";
export const GAME = "fortune-chimp";

export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });
export const at = (offsetMs: number): Date => addMilliseconds(T0, offsetMs);

export class Sequence {
  private n = 0;

  constructor(private readonly prefix: string) {}

  next(): string {
    this.n += 1;
    return `${this.prefix}-${String(this.n).padStart(4, "0")}`;
  }
}

export function newWallet(
  props: { id?: string; playerId?: string; balance?: string; currency?: string } = {},
): Wallet {
  const id = props.id ?? WALLET;
  const initialBalance = Money.from({
    amount: props.balance ?? "100.00",
    currency: props.currency ?? "BRL",
  });
  return Wallet.open({
    id,
    playerId: props.playerId ?? PLAYER,
    initialBalance,
    at: T0,
    opening: initialBalance.isPositive()
      ? { transactionId: `opening-${id}`, ledgerEntryId: `entry-opening-${id}` }
      : undefined,
  });
}

export interface WagerOverrides {
  id?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  gameId?: string;
  money?: Money;
  reference?: string | undefined;
  createdAt?: Date;
}

export function wager(
  kind: WagerTransactionKind,
  overrides: WagerOverrides = {},
): WagerTransaction {
  const providerId = overrides.providerId ?? PROVIDER;
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${kind.toLowerCase()}`;
  const fields = {
    providerId,
    externalTransactionId,
    playerId: overrides.playerId ?? PLAYER,
    walletId: overrides.walletId ?? WALLET,
    roundId: overrides.roundId ?? ROUND,
    gameId: overrides.gameId ?? GAME,
    kind,
    money: overrides.money ?? brl("10.00"),
    referenceExternalTransactionId: overrides.reference,
  };
  return WagerTransaction.create({
    ...fields,
    id: overrides.id ?? `tx-${externalTransactionId}`,
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    payloadHash: computeWagerPayloadHash(fields),
    createdAt: overrides.createdAt ?? T0,
  });
}

export const RETRY: ReferenceRetryPolicy = {
  backoff: ExponentialBackoff.of({ baseMs: 1_000, maxMs: 60_000 }),
  ttlMs: 15 * 60_000,
  random: () => 0.5,
};

export interface Submitted {
  readonly transaction: WagerTransaction;
  readonly outcome: SettlementOutcome;
}

/**
 * One wallet and its transactions in memory. References are loaded the way the use case will load
 * them from the database: by (providerId, referenceExternalTransactionId), then the PROCESSED
 * dependents of the reference and the PROCESSED ROLLBACKs of those dependents.
 */
export class WagerScenario {
  readonly wallet: Wallet;
  readonly transactions: WagerTransaction[] = [];
  readonly ledger: WalletLedgerEntry[] = [];
  now: Date = T0;
  private readonly entryIds = new Sequence("entry");

  constructor(props: { balance?: string; currency?: string } = {}) {
    this.wallet = newWallet(props);
    this.ledger.push(...this.wallet.pullNewLedgerEntries());
  }

  submit(
    kind: WagerTransactionKind,
    externalTransactionId: string,
    overrides: Omit<WagerOverrides, "externalTransactionId" | "id" | "createdAt"> = {},
  ): Submitted {
    this.now = addMilliseconds(this.now, 1_000);
    const transaction = wager(kind, {
      ...overrides,
      externalTransactionId,
      walletId: overrides.walletId ?? this.wallet.id,
      createdAt: this.now,
    });
    this.transactions.push(transaction);
    return { transaction, outcome: this.settle(transaction) };
  }

  /** What the PENDING_REFERENCE worker does: settle again, later. */
  recheck(transaction: WagerTransaction, now: Date): SettlementOutcome {
    this.now = now;
    return this.settle(transaction);
  }

  referenceStateFor(transaction: WagerTransaction): ReferenceState {
    const reference = this.transactions.find(
      (candidate) =>
        candidate.providerId === transaction.providerId &&
        candidate.externalTransactionId === transaction.referenceExternalTransactionId,
    );
    if (reference === undefined) {
      return ReferenceState.notFound();
    }
    const dependents = this.transactions.filter(
      (candidate) =>
        candidate.status === WagerTransactionStatus.Processed &&
        candidate.referenceTransactionId === reference.id,
    );
    const dependentIds = new Set(dependents.map((dependent) => dependent.id));
    const dependentRollbacks = this.transactions.filter(
      (candidate) =>
        candidate.kind === WagerTransactionKind.Rollback &&
        candidate.status === WagerTransactionStatus.Processed &&
        candidate.referenceTransactionId !== undefined &&
        dependentIds.has(candidate.referenceTransactionId),
    );
    return ReferenceState.evaluate({ reference, dependents, dependentRollbacks });
  }

  /** Balance rebuilt from the ledger alone: must always equal wallet.balance. */
  ledgerBalance(): Money {
    return this.ledger.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      Money.zero(this.wallet.currency),
    );
  }

  private settle(transaction: WagerTransaction): SettlementOutcome {
    const outcome = settleWager({
      transaction,
      wallet: this.wallet,
      reference: transaction.hasReference() ? this.referenceStateFor(transaction) : undefined,
      ledgerEntryId: this.entryIds.next(),
      at: this.now,
      referenceRetry: RETRY,
    });
    this.ledger.push(...this.wallet.pullNewLedgerEntries());
    return outcome;
  }
}
