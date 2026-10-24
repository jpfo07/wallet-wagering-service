import { Decimal } from "decimal.js";
import { ErrorCode } from "./failure-code.ts";
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from "./money.errors.ts";

/** Contract shape: `{ "amount": "25.00", "currency": "BRL" }`. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

// Private Decimal constructor: the global decimal.js config is never touched. 40 significant digits
// is far beyond numeric(20,2), so add/subtract of 2-decimal values are always exact.
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

// Exactly 2 decimals, no sign, no leading zeros (one canonical spelling per value, which keeps the
// payload hash stable) and at most 18 integer digits, which is what numeric(20,2) stores.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_ABSOLUTE = new Dec("999999999999999999.99");
const SCALE = 2;

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Strict entry contract: rejects anything that is not a non-negative 2-decimal string. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props as { amount: unknown; currency: unknown };
    Money.assertCurrency(currency);
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        ErrorCode.InvalidAmount,
        'amount must be a non-negative decimal string with exactly 2 places (e.g. "25.00")',
      );
    }
    return Money.of(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return Money.of(new Dec(0), currency);
  }

  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Comparing is not operating: a different currency is simply "not equal". */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private static of(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(MAX_ABSOLUTE)) {
      throw new MoneyOverflowError();
    }
    // Normalizes -0 so that negate(0) serializes as "0.00", never "-0.00".
    return new Money(value.isZero() ? new Dec(0) : value, currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        ErrorCode.InvalidCurrency,
        "currency must be a 3-letter uppercase ISO-4217 code",
      );
    }
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
