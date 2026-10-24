import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const DOMAIN = resolve(ROOT, "src/domain");

const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: DOMAIN })].map((file) =>
  resolve(DOMAIN, file),
);

/** The only external modules the domain may use, and where. */
const ALLOWED_EXTERNAL: Readonly<Record<string, readonly string[]>> = {
  "decimal.js": ["shared/money.ts"],
  "node:crypto": ["idempotency/payload-hash.ts"],
};

/** Clock, randomness, ids and float parsing must come from the caller, never from the domain. */
const FORBIDDEN_CODE: readonly (readonly [RegExp, string])[] = [
  [/\bDate\.now\s*\(/, "Date.now()"],
  [/\bnew Date\(\s*\)/, "new Date() without arguments"],
  [/\bMath\.random\b/, "Math.random"],
  [/\brandomUUID\b/, "randomUUID"],
  [/\brandomUUIDv7\b/, "Bun.randomUUIDv7"],
  [/\bparseFloat\s*\(/, "parseFloat"],
  [/\bNumber\s*\(/, "Number()"],
  [/\bprocess\.env\b/, "process.env"],
];

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("domain boundaries", () => {
  test("there are domain files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("imports stay inside src/domain, except for the allow-listed modules", () => {
    const violations: string[] = [];
    for (const file of files) {
      const name = relative(DOMAIN, file);
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (!target.startsWith(`${DOMAIN}/`)) {
            violations.push(`${name} → ${specifier}`);
          }
        } else if (!(ALLOWED_EXTERNAL[specifier] ?? []).includes(name)) {
          violations.push(`${name} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("no clock, randomness, id generation or float parsing inside the domain", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [pattern, label] of FORBIDDEN_CODE) {
        if (pattern.test(source)) {
          violations.push(`${relative(DOMAIN, file)}: ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the import scanner catches what it must catch", () => {
    expect(importsOf('import { Module } from "@nestjs/common";')).toEqual(["@nestjs/common"]);
    expect(importsOf('import type { EntityManager } from "@mikro-orm/core";')).toEqual([
      "@mikro-orm/core",
    ]);
    expect(importsOf('export { x } from "../../infrastructure/x.ts";')).toEqual([
      "../../infrastructure/x.ts",
    ]);
    expect(importsOf('await import("@nestjs/core");')).toEqual(["@nestjs/core"]);
    expect(importsOf('import "reflect-metadata";')).toEqual(["reflect-metadata"]);
  });
});
