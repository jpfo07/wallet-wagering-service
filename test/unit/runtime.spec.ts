import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };

describe("runtime", () => {
  test("bun test runs", () => {
    expect(1 + 1).toBe(2);
  });

  test("Bun version matches .bun-version and package.json", async () => {
    const pinned = (await Bun.file(new URL("../../.bun-version", import.meta.url)).text()).trim();
    // The compat matrix runs the same suite on another Bun on purpose.
    const expected = process.env["EXPECTED_BUN_VERSION"] ?? pinned;
    expect(Bun.version).toBe(expected);
    expect(packageJson.packageManager).toBe(`bun@${pinned}`);
    expect(packageJson.engines.bun).toBe(pinned);
  });
});
