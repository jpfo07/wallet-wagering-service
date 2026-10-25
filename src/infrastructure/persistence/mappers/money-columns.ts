import { Money } from "../../../domain/shared/money.ts";
import { PersistenceMappingError } from "./persistence-mapping.error.ts";

/**
 * Money ↔ (numeric(20,2), char(3)). The driver returns numeric as a string with exactly 2 decimals
 * ("0.10", "975.00"), which is precisely Money's strict entry contract, so the value never passes
 * through `number`. A corrupted row fails loudly here instead of becoming an invalid Money.
 */
export function moneyFromColumns(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}

export function optionalMoneyFromColumns(
  amount: string | null | undefined,
  currency: string | null | undefined,
): Money | undefined {
  if (amount == null && currency == null) return undefined;
  if (amount == null || currency == null) {
    throw new PersistenceMappingError("money columns must be both null or both set");
  }
  return moneyFromColumns(amount, currency);
}

export function moneyToColumns(money: Money): { amount: string; currency: string } {
  return { amount: money.amount, currency: money.currency };
}
