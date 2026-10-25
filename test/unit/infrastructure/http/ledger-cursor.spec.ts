import { describe, expect, test } from "bun:test";
import { InvalidRequestError } from "../../../../src/infrastructure/http/http-errors.ts";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from "../../../../src/infrastructure/http/ledger-cursor.ts";

const b64 = (plain: string): string => Buffer.from(plain, "utf8").toString("base64url");

describe("ledger cursor", () => {
  test.each([0, 1, 42, Number.MAX_SAFE_INTEGER])("round trip of version %p", (version) => {
    const cursor = encodeLedgerCursor(version);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no padding
    expect(decodeLedgerCursor(cursor)).toBe(version);
  });

  test.each([
    ["empty", ""],
    ["not base64url", "v1:3"],
    ["padding", `${b64("v1:3")}=`],
    ["other version prefix", b64("v2:3")],
    ["negative", b64("v1:-1")],
    ["leading zero", b64("v1:03")],
    ["decimal", b64("v1:1.5")],
    ["beyond safe integer", b64("v1:9999999999999999")],
    ["trailing data", b64("v1:3 ")],
  ])("rejects %s", (_label, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidRequestError);
  });
});
