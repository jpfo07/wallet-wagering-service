import { describe, expect, test } from "bun:test";
import type { LedgerEntryView, WalletView } from "../../../src/application/views.ts";
import type { LedgerPageResponse } from "../../../src/infrastructure/http/wallets.controller.ts";
import {
  createWalletViaApi,
  expectApiError,
  submitViaApi,
  wagerRequest,
} from "../../support/api-builders.ts";
import { useApiSuite } from "../../support/api-suite.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("HTTP API — wallets, ledger, reconciliation (real app, PostgreSQL, LocalStack)", () => {
  const suite = useApiSuite("api-wallets");

  describe("POST /wallets", () => {
    test("201 with the wallet at version 1, and the OPENING in the ledger", async () => {
      const playerId = Bun.randomUUIDv7();
      const response = await suite().request("/wallets", {
        method: "POST",
        body: { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } },
      });
      expect(response.status).toBe(201);
      const wallet = response.body as WalletView;
      expect(wallet.id).toMatch(UUID);
      expect(wallet).toEqual({
        id: wallet.id,
        playerId,
        balance: { amount: "1000.00", currency: "BRL" },
        version: 1,
      });
      expect(response.headers.get("x-instance-id")).toBe("api-test-1");
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("409 WALLET_ALREADY_EXISTS for the same player and currency", async () => {
      const wallet = await createWalletViaApi(suite());
      const response = await suite().request("/wallets", {
        method: "POST",
        body: { playerId: wallet.playerId, initialBalance: { amount: "5.00", currency: "BRL" } },
      });
      expectApiError(response, 409, "WALLET_ALREADY_EXISTS");
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test.each([
      ["playerId is not a UUID", { playerId: "player-1" }, "INVALID_PAYLOAD", "body.playerId"],
      ["unknown field", { nickname: "x" }, "INVALID_PAYLOAD", "body"],
      [
        "amount as a number",
        { initialBalance: { amount: 10, currency: "BRL" } },
        "INVALID_PAYLOAD",
        "body.initialBalance.amount",
      ],
    ] as const)("400 %s, with details", async (_label, patch, code, path) => {
      const response = await suite().request("/wallets", {
        method: "POST",
        body: {
          playerId: Bun.randomUUIDv7(),
          initialBalance: { amount: "10.00", currency: "BRL" },
          ...patch,
        },
      });
      expectApiError(response, 400, code);
      const { details } = response.body as { details: { path: string }[] };
      expect(details.map((detail) => detail.path)).toContain(path);
    });

    test.each([
      ["amount without the 2 decimals", { amount: "25", currency: "BRL" }, "INVALID_AMOUNT"],
      ["negative amount", { amount: "-1.00", currency: "BRL" }, "INVALID_AMOUNT"],
      ["lowercase currency", { amount: "1.00", currency: "brl" }, "INVALID_CURRENCY"],
    ] as const)("400 %s (Money's own code)", async (_label, initialBalance, code) => {
      const response = await suite().request("/wallets", {
        method: "POST",
        body: { playerId: Bun.randomUUIDv7(), initialBalance },
      });
      expectApiError(response, 400, code);
    });

    test("400 on malformed JSON, in the same error format", async () => {
      const response = await suite().request("/wallets", { method: "POST", body: "{ not json" });
      expectApiError(response, 400, "INVALID_PAYLOAD");
    });
  });

  describe("GET /wallets/:walletId", () => {
    test("200 with the current balance; uppercase id is the same wallet", async () => {
      const wallet = await createWalletViaApi(suite(), "42.00");
      const response = await suite().request(`/wallets/${wallet.id}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(wallet);
      const upper = await suite().request(`/wallets/${wallet.id.toUpperCase()}`);
      expect(upper.body).toEqual(wallet);
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("404 WALLET_NOT_FOUND; 400 on an id that is not a UUID", async () => {
      expectApiError(
        await suite().request(`/wallets/${Bun.randomUUIDv7()}`),
        404,
        "WALLET_NOT_FOUND",
      );
      expectApiError(await suite().request("/wallets/not-a-uuid"), 400, "INVALID_PAYLOAD");
    });
  });

  describe("GET /wallets/:walletId/ledger", () => {
    test("pages through every entry with the opaque cursor, in wallet_version order", async () => {
      const wallet = await createWalletViaApi(suite(), "100.00");
      for (let i = 0; i < 5; i += 1) {
        const response = await submitViaApi(
          suite(),
          wagerRequest(wallet, "BET", { amount: "1.00" }),
        );
        expect(response.status).toBe(200);
      }

      const versions: number[] = [];
      const cursors: string[] = [];
      let cursor: string | undefined;
      do {
        const query = cursor === undefined ? "?limit=2" : `?limit=2&cursor=${cursor}`;
        const response = await suite().request(`/wallets/${wallet.id}/ledger${query}`);
        expect(response.status).toBe(200);
        const page = response.body as LedgerPageResponse;
        expect(page.entries.length).toBeLessThanOrEqual(2);
        versions.push(...page.entries.map((entry: LedgerEntryView) => entry.walletVersion));
        cursor = page.nextCursor;
        if (cursor !== undefined) cursors.push(cursor);
      } while (cursor !== undefined);

      expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
      expect(cursors).toHaveLength(2);
      for (const issued of cursors) expect(issued).toMatch(/^[A-Za-z0-9_-]+$/);

      const all = (await suite().request(`/wallets/${wallet.id}/ledger`))
        .body as LedgerPageResponse;
      expect(all.entries).toHaveLength(6); // default limit (50) covers everything
      expect(all.nextCursor).toBeUndefined();
      expect(all.entries[1]).toMatchObject({
        direction: "DEBIT",
        money: { amount: "1.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "99.00", currency: "BRL" },
      });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test.each([
      ["cursor that is not base64url", "?cursor=@@@"],
      ["cursor with another format", `?cursor=${Buffer.from("v2:3").toString("base64url")}`],
      ["cursor with a negative version", `?cursor=${Buffer.from("v1:-1").toString("base64url")}`],
      ["cursor with a leading zero", `?cursor=${Buffer.from("v1:03").toString("base64url")}`],
      ["limit 0", "?limit=0"],
      ["limit above the maximum", "?limit=201"],
      ["limit that is not an integer", "?limit=1.5"],
    ])("400 on %s", async (_label, query) => {
      const wallet = await createWalletViaApi(suite());
      expectApiError(
        await suite().request(`/wallets/${wallet.id}/ledger${query}`),
        400,
        "INVALID_PAYLOAD",
      );
    });

    test("limit 200 is accepted; 404 for an unknown wallet", async () => {
      const wallet = await createWalletViaApi(suite());
      expect((await suite().request(`/wallets/${wallet.id}/ledger?limit=200`)).status).toBe(200);
      expectApiError(
        await suite().request(`/wallets/${Bun.randomUUIDv7()}/ledger`),
        404,
        "WALLET_NOT_FOUND",
      );
    });
  });

  describe("POST /wallets/:walletId/reconciliation", () => {
    test("200 consistent, with the number of entries checked", async () => {
      const wallet = await createWalletViaApi(suite(), "100.00");
      await submitViaApi(suite(), wagerRequest(wallet, "BET", { amount: "25.00" }));
      const response = await suite().request(`/wallets/${wallet.id}/reconciliation`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: "75.00", currency: "BRL" },
        calculatedBalance: { amount: "75.00", currency: "BRL" },
        difference: { amount: "0.00", currency: "BRL" },
        consistent: true,
        checkedEntries: 2,
      });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("404 WALLET_NOT_FOUND", async () => {
      expectApiError(
        await suite().request(`/wallets/${Bun.randomUUIDv7()}/reconciliation`, { method: "POST" }),
        404,
        "WALLET_NOT_FOUND",
      );
    });
  });

  describe("X-Correlation-Id and unknown routes", () => {
    test("an acceptable id is echoed on success and on errors (header and body)", async () => {
      const ok = await suite().request("/health/live", {
        headers: { "X-Correlation-Id": "abc-123" },
      });
      expect(ok.headers.get("x-correlation-id")).toBe("abc-123");
      const error = await suite().request(`/wallets/${Bun.randomUUIDv7()}`, {
        headers: { "X-Correlation-Id": "trace:42.a_b" },
      });
      expect(error.headers.get("x-correlation-id")).toBe("trace:42.a_b");
      expect((error.body as { correlationId: string }).correlationId).toBe("trace:42.a_b");
    });

    test("absent or unacceptable → a new one is generated (never a 400)", async () => {
      const absent = await suite().request("/health/live");
      const invalid = await suite().request("/health/live", {
        headers: { "X-Correlation-Id": "x".repeat(129) },
      });
      expect(absent.status).toBe(200);
      expect(invalid.status).toBe(200);
      expect(absent.headers.get("x-correlation-id")).toMatch(UUID);
      expect(invalid.headers.get("x-correlation-id")).toMatch(UUID);
      expect(invalid.headers.get("x-correlation-id")).not.toBe(
        absent.headers.get("x-correlation-id"),
      );
    });

    test("404 ROUTE_NOT_FOUND in the same error format", async () => {
      const response = await suite().request("/nowhere", {
        headers: { "X-Correlation-Id": "route-test" },
      });
      expectApiError(response, 404, "ROUTE_NOT_FOUND");
      expect(response.headers.get("x-correlation-id")).toBe("route-test");
    });

    test("health endpoints keep answering", async () => {
      const ready = await suite().request("/health/ready");
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
    });
  });
});
