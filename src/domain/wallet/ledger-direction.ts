export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

const DIRECTIONS: ReadonlySet<string> = new Set(Object.values(LedgerDirection));

export function isLedgerDirection(value: string): value is LedgerDirection {
  return DIRECTIONS.has(value);
}
