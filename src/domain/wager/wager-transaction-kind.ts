export enum WagerTransactionKind {
  /** Internal only: the opening credit of a wallet. Never accepted from HTTP or SQS. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

const KINDS: ReadonlySet<string> = new Set(Object.values(WagerTransactionKind));

export function isWagerTransactionKind(value: string): value is WagerTransactionKind {
  return KINDS.has(value);
}
