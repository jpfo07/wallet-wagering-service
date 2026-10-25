import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const PERSISTENCE = resolve(ROOT, "src/infrastructure/persistence");

const scan = (dir: string): string[] =>
  [...new Bun.Glob("**/*.ts").scanSync({ cwd: resolve(PERSISTENCE, dir) })].map((file) =>
    resolve(PERSISTENCE, dir, file),
  );

const MONEY_PROPERTY = /^\s*(amount|balance\w*|observedBalanceAmount)\s*:/i;

describe("money never becomes a number in persistence", () => {
  test("no float/double types and no numeric mapped to number in the models", () => {
    const violations: string[] = [];
    for (const file of scan("models")) {
      const source = readFileSync(file, "utf8");
      for (const [pattern, label] of [
        [/\bp\.(double|float|real)\s*\(/, "p.double/p.float"],
        [/\bp\.decimal\(\s*["']number["']/, 'p.decimal("number")'],
      ] as const) {
        if (pattern.test(source)) violations.push(`${file}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('every money property is p.decimal("string") numeric(20,2)', () => {
    const moneyLines = scan("models").flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => MONEY_PROPERTY.test(line))
        .map((line) => ({ file, line: line.trim() })),
    );
    expect(moneyLines.length).toBe(6);
    for (const { file, line } of moneyLines) {
      expect(line, file).toContain('p.decimal("string").precision(20).scale(2)');
    }
  });

  test("mappers and migrations never parse money as a float", () => {
    const violations = [...scan("mappers"), ...scan("migrations")].filter((file) =>
      /\bparseFloat\s*\(|\bNumber\s*\(|\bparseInt\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });
});
