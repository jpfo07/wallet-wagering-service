import { describe, expect, test } from "bun:test";
import { ErrorCode } from "../../../../src/domain/shared/failure-code.ts";
import { Money } from "../../../../src/domain/shared/money.ts";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MoneyOverflowError,
} from "../../../../src/domain/shared/money.errors.ts";
import { brl, usd } from "../../../support/domain-builders.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

describe("Money.from (strict entry contract)", () => {
  test.each(["0.00", "0.01", "25.00", "1000.50", "999999999999999999.99"])(
    "accepts %p",
    (amount) => {
      expect(Money.from({ amount, currency: "BRL" }).amount).toBe(amount);
    },
  );

  test.each([
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["scientific notation", "1e3"],
    ["scientific notation with decimals", "1.00e2"],
    ["empty string", ""],
    ["leading whitespace", " 1.00"],
    ["trailing whitespace", "1.00 "],
    ["explicit plus sign", "+1.00"],
    ["negative", "-1.00"],
    ["negative zero", "-0.00"],
    ["comma separator", "1,00"],
    ["integer without scale", "25"],
    ["one decimal", "25.5"],
    ["three decimals (no implicit rounding)", "25.000"],
    ["three significant decimals", "0.005"],
    ["leading zero", "01.00"],
    ["missing integer part", ".50"],
    ["hexadecimal", "0x10"],
    ["19 integer digits (exceeds numeric(20,2))", "1000000000000000000.00"],
  ])("rejects %s", (_label, amount) => {
    expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(codeOf(() => Money.from({ amount, currency: "BRL" }))).toBe(ErrorCode.InvalidAmount);
  });

  test("rejects a number disguised as a string at runtime", () => {
    const props = { amount: 25 as unknown as string, currency: "BRL" };
    expect(codeOf(() => Money.from(props))).toBe(ErrorCode.InvalidAmount);
  });

  test.each(["brl", "BR", "BRLX", "", "B1L", " BRL"])("rejects currency %p", (currency) => {
    expect(codeOf(() => Money.from({ amount: "1.00", currency }))).toBe(ErrorCode.InvalidCurrency);
    expect(codeOf(() => Money.zero(currency))).toBe(ErrorCode.InvalidCurrency);
  });
});

describe("Money arithmetic", () => {
  test("is exact in decimal (0.10 + 0.20 = 0.30)", () => {
    expect(brl("0.10").add(brl("0.20")).amount).toBe("0.30");
  });

  test("keeps precision at the top of the range", () => {
    expect(brl("999999999999999999.98").add(brl("0.01")).amount).toBe("999999999999999999.99");
  });

  test("subtract can go negative (e.g. a reconciliation difference)", () => {
    const difference = brl("10.00").subtract(brl("10.01"));
    expect(difference.amount).toBe("-0.01");
    expect(difference.isNegative()).toBe(true);
  });

  test("negate flips the sign and never produces -0.00", () => {
    expect(brl("25.00").negate().amount).toBe("-25.00");
    expect(brl("0.00").negate().amount).toBe("0.00");
    expect(brl("1.00").subtract(brl("1.00")).negate().amount).toBe("0.00");
  });

  test("overflow beyond numeric(20,2) is an invariant error, never a silent wrap or rounding", () => {
    expect(() => brl("999999999999999999.99").add(brl("0.01"))).toThrow(MoneyOverflowError);
  });

  test("results always serialize with exactly 2 decimals", () => {
    expect(brl("1.10").add(brl("2.90")).amount).toBe("4.00");
    expect(Money.zero("BRL").amount).toBe("0.00");
  });
});

describe("Money comparisons", () => {
  test("sign checks", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.00").isNegative()).toBe(false);
  });

  test("isLessThan", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
  });

  test("equals compares value and currency", () => {
    expect(brl("10.00").equals(brl("10.00"))).toBe(true);
    expect(brl("10.00").equals(brl("10.01"))).toBe(false);
    expect(brl("10.00").equals(usd("10.00"))).toBe(false);
  });
});

describe("Money currency conflict", () => {
  test.each([
    ["add", (a: Money, b: Money) => a.add(b)],
    ["subtract", (a: Money, b: Money) => a.subtract(b)],
    ["isLessThan", (a: Money, b: Money) => a.isLessThan(b)],
  ])("%s between BRL and USD throws", (_name, operation) => {
    expect(() => operation(brl("1.00"), usd("1.00"))).toThrow(CurrencyMismatchError);
  });
});

describe("Money immutability and serialization", () => {
  test("operations return new instances and leave the original untouched", () => {
    const original = brl("10.00");
    const sum = original.add(brl("5.00"));
    original.negate();
    original.subtract(brl("1.00"));
    expect(sum).not.toBe(original);
    expect(original.amount).toBe("10.00");
  });

  test("instances are frozen", () => {
    const money = brl("10.00");
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = "USD";
    }).toThrow();
  });

  test("toJSON is the contract shape, toString is for humans", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(JSON.stringify({ money: brl("25.00") })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });
});
