import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const APPLICATION = resolve(ROOT, "src/application");
const DOMAIN = resolve(ROOT, "src/domain");

const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: APPLICATION })].map((file) =>
  resolve(APPLICATION, file),
);

/** Clock, randomness and ids reach the use cases through ports (Clock, IdGenerator, RandomSource). */
const FORBIDDEN_CODE: readonly (readonly [RegExp, string])[] = [
  [/\bDate\.now\s*\(/, "Date.now()"],
  [/\bnew Date\(\s*\)/, "new Date() without arguments"],
  [/\bMath\.random\b/, "Math.random"],
  [/\brandomUUID(v7)?\b/, "randomUUID"],
  [/\bparseFloat\s*\(/, "parseFloat"],
  [/\bprocess\.env\b/, "process.env"],
];

function importsOf(source: string): string[] {
  const pattern =
    /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].flatMap((match) => {
    const specifier = match[1] ?? match[2] ?? match[3];
    return specifier === undefined ? [] : [specifier];
  });
}

describe("application boundaries", () => {
  test("there are application files to check", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  test("the application only depends on itself and on the domain (no Nest, no MikroORM)", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        const target = specifier.startsWith(".") ? resolve(dirname(file), specifier) : undefined;
        const allowed =
          target !== undefined &&
          (target.startsWith(`${APPLICATION}/`) || target.startsWith(`${DOMAIN}/`));
        if (!allowed) violations.push(`${relative(APPLICATION, file)} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("no clock, randomness or id generation inside the use cases", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [pattern, label] of FORBIDDEN_CODE) {
        if (pattern.test(source)) violations.push(`${relative(APPLICATION, file)}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
