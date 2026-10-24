import { describe, expect, test } from "bun:test";
import {
  CanonicalJsonError,
  canonicalJson,
} from "../../../../src/domain/idempotency/canonical-json.ts";
import type { CanonicalJsonValue } from "../../../../src/domain/idempotency/canonical-json.ts";
import { brl } from "../../../support/domain-builders.ts";

describe("canonicalJson", () => {
  test("sorts keys recursively and has no whitespace", () => {
    expect(canonicalJson({ b: "2", a: { d: "4", c: "3" }, list: [{ z: "1", y: "0" }] })).toBe(
      '{"a":{"c":"3","d":"4"},"b":"2","list":[{"y":"0","z":"1"}]}',
    );
  });

  test("key order of the input does not matter", () => {
    expect(canonicalJson({ a: "1", b: "2" })).toBe(canonicalJson({ b: "2", a: "1" }));
  });

  test("keeps array order (arrays are ordered data)", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
  });

  test("sorts by UTF-16 code unit (uppercase before lowercase)", () => {
    expect(canonicalJson({ b: "1", B: "2", a: "3" })).toBe('{"B":"2","a":"3","b":"1"}');
  });

  test("escapes strings like JSON.stringify", () => {
    expect(canonicalJson({ s: 'quote " and \\ and \n and ç' })).toBe(
      '{"s":"quote \\" and \\\\ and \\n and ç"}',
    );
  });

  test("omits undefined properties", () => {
    expect(canonicalJson({ a: "1", b: undefined })).toBe('{"a":"1"}');
  });

  test("booleans", () => {
    expect(canonicalJson({ t: true, f: false })).toBe('{"f":false,"t":true}');
  });

  test.each([
    ["a number (money must be a string; 1 vs 1.0 is ambiguous)", { amount: 25 }],
    ["null", { value: null }],
    ["a Date", { at: new Date(0) }],
    ["a class instance such as Money", { money: brl("1.00") }],
    ["an undefined array item", { list: ["a", undefined] }],
    ["a bigint", { n: 1n }],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value as unknown as CanonicalJsonValue)).toThrow(CanonicalJsonError);
  });
});
