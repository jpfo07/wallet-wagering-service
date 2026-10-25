import { describe, expect, test } from "bun:test";
import type { TransactionView, WagerTransactionResult } from "../../../src/application/views.ts";
import { FailureCode } from "../../../src/domain/shared/failure-code.ts";
import { WagerTransactionKind } from "../../../src/domain/wager/wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../../../src/domain/wager/wager-transaction-status.ts";
import {
  createWalletViaApi,
  expectApiError,
  submitViaApi,
  wagerRequest,
} from "../../support/api-builders.ts";
import { RETRY_AFTER_SECONDS, useApiSuite } from "../../support/api-suite.ts";
import { ledgerRows, transactionRows, walletState } from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { holdWalletLock } from "../../support/lock-barrier.ts";

const result = (body: unknown): WagerTransactionResult => body as WagerTransactionResult;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("HTTP API — wagering transactions (real app, PostgreSQL, LocalStack)", () => {
  const suite = useApiSuite("api-wagering");

  describe("status by outcome; same body for success, rejection and replay", () => {
    test("200 PROCESSED, then 200 replay with the identical body and idempotentReplay", async () => {
      const { sql } = suite();
      const wallet = await createWalletViaApi(suite(), "100.00");
      const request = wagerRequest(wallet, "BET", { amount: "25.00" });

      const first = await submitViaApi(suite(), request);
      expect(first.status).toBe(200);
      expect(result(first.body).transactionId).toMatch(UUID);
      expect(first.body).toEqual({
        transactionId: result(first.body).transactionId,
        status: "PROCESSED",
        balance: { amount: "75.00", currency: "BRL" },
        idempotentReplay: false,
      });

      const replay = await submitViaApi(suite(), request);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...result(first.body), idempotentReplay: true });
      expect(
        (await ledgerRows(sql, wallet.id)).filter((e) => e.direction === "DEBIT"),
      ).toHaveLength(1);
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "75.00", version: 2 });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("422 REJECTED with failureCode, and the replay is the same 422", async () => {
      const wallet = await createWalletViaApi(suite(), "10.00");
      const request = wagerRequest(wallet, "BET", { amount: "50.00" });
      const first = await submitViaApi(suite(), request);
      expect(first.status).toBe(422);
      expect(first.body).toEqual({
        transactionId: result(first.body).transactionId,
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        balance: { amount: "10.00", currency: "BRL" },
        idempotentReplay: false,
      });
      const replay = await submitViaApi(suite(), request);
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...result(first.body), idempotentReplay: true });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("202 PENDING_REFERENCE (REFUND before its BET), and the replay is the same 202", async () => {
      const wallet = await createWalletViaApi(suite(), "100.00");
      const request = wagerRequest(wallet, "REFUND", { reference: "bet-not-yet-arrived" });
      const first = await submitViaApi(suite(), request);
      expect(first.status).toBe(202);
      expect(result(first.body)).toMatchObject({
        status: "PENDING_REFERENCE",
        idempotentReplay: false,
      });
      const replay = await submitViaApi(suite(), request);
      expect(replay.status).toBe(202);
      expect(replay.body).toEqual({ ...result(first.body), idempotentReplay: true });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("uppercase UUIDs: same identifiers, same hash → replay, not conflict", async () => {
      const wallet = await createWalletViaApi(suite(), "100.00");
      const request = wagerRequest(wallet, "BET", { amount: "5.00" });
      const first = await submitViaApi(suite(), request);
      const upper = {
        ...request,
        body: {
          ...request.body,
          walletId: wallet.id.toUpperCase(),
          playerId: wallet.playerId.toUpperCase(),
        },
      };
      const replay = await submitViaApi(suite(), upper);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...result(first.body), idempotentReplay: true });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });
  });

  describe("409 idempotency conflicts", () => {
    test("IDEMPOTENCY_KEY_REUSED: same key, different payload; points to the existing transaction", async () => {
      const wallet = await createWalletViaApi(suite(), "100.00");
      const request = wagerRequest(wallet, "BET", { amount: "10.00" });
      const first = result((await submitViaApi(suite(), request)).body);
      const conflict = await submitViaApi(suite(), {
        ...request,
        body: { ...request.body, money: { amount: "11.00", currency: "BRL" } },
      });
      expectApiError(conflict, 409, "IDEMPOTENCY_KEY_REUSED");
      expect((conflict.body as { transactionId: string }).transactionId).toBe(first.transactionId);
      expect(await walletState(suite().sql, wallet.id)).toEqual({ balance: "90.00", version: 2 });
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("EXTERNAL_TRANSACTION_ID_CONFLICT: same externalTransactionId under another key", async () => {
      const wallet = await createWalletViaApi(suite(), "100.00");
      const request = wagerRequest(wallet, "BET", { amount: "10.00" });
      await submitViaApi(suite(), request);
      const conflict = await submitViaApi(suite(), { ...request, idempotencyKey: "another-key" });
      expectApiError(conflict, 409, "EXTERNAL_TRANSACTION_ID_CONFLICT");
      await assertLedgerInvariant(suite().sql, wallet.id);
    });
  });

  describe("400 invalid payload: nothing is persisted", () => {
    const cases: readonly (readonly [
      string,
      (req: { idempotencyKey: string; body: Record<string, unknown> }) => {
        idempotencyKey: string | undefined;
        body: unknown;
      },
      string,
    ])[] = [
      ["missing Idempotency-Key", (r) => ({ ...r, idempotencyKey: undefined }), "INVALID_PAYLOAD"],
      ["blank Idempotency-Key", (r) => ({ ...r, idempotencyKey: "   " }), "INVALID_PAYLOAD"],
      [
        "256-char Idempotency-Key",
        (r) => ({ ...r, idempotencyKey: "k".repeat(256) }),
        "INVALID_PAYLOAD",
      ],
      [
        "256-char providerId",
        (r) => ({ ...r, body: { ...r.body, providerId: "p".repeat(256) } }),
        "INVALID_PAYLOAD",
      ],
      [
        "256-char roundId",
        (r) => ({ ...r, body: { ...r.body, roundId: "r".repeat(256) } }),
        "INVALID_PAYLOAD",
      ],
      [
        "walletId not a UUID",
        (r) => ({ ...r, body: { ...r.body, walletId: "wallet-1" } }),
        "INVALID_PAYLOAD",
      ],
      [
        "unknown field",
        (r) => ({ ...r, body: { ...r.body, referenceExternalTransactionID: "x" } }),
        "INVALID_PAYLOAD",
      ],
      [
        "missing money",
        (r) => ({ ...r, body: { ...r.body, money: undefined } }),
        "INVALID_PAYLOAD",
      ],
      ["unknown kind", (r) => ({ ...r, body: { ...r.body, kind: "JACKPOT" } }), "INVALID_PAYLOAD"],
      ["kind OPENING", (r) => ({ ...r, body: { ...r.body, kind: "OPENING" } }), "KIND_NOT_ALLOWED"],
      [
        "providerId internal",
        (r) => ({ ...r, body: { ...r.body, providerId: "internal" } }),
        "PROVIDER_RESERVED",
      ],
      [
        "amount without 2 decimals",
        (r) => ({ ...r, body: { ...r.body, money: { amount: "25", currency: "BRL" } } }),
        "INVALID_AMOUNT",
      ],
      [
        "amount with 3 decimals",
        (r) => ({ ...r, body: { ...r.body, money: { amount: "1.000", currency: "BRL" } } }),
        "INVALID_AMOUNT",
      ],
      [
        "BET with a reference",
        (r) => ({ ...r, body: { ...r.body, referenceExternalTransactionId: "x" } }),
        "REFERENCE_NOT_ALLOWED",
      ],
    ];

    test.each(cases)("%s", async (_label, mutate, code) => {
      const { sql } = suite();
      const wallet = await createWalletViaApi(suite(), "100.00");
      const { idempotencyKey, body } = mutate(wagerRequest(wallet, "BET"));
      const response = await suite().request("/wagering/transactions", {
        method: "POST",
        headers: idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey },
        body,
      });
      expectApiError(response, 400, code);
      expect(await transactionRows(sql, wallet.id)).toHaveLength(1); // only the OPENING
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("REFUND without a reference is REFERENCE_REQUIRED", async () => {
      const wallet = await createWalletViaApi(suite(), "100.00");
      expectApiError(
        await submitViaApi(suite(), wagerRequest(wallet, "REFUND")),
        400,
        "REFERENCE_REQUIRED",
      );
    });

    test("malformed JSON", async () => {
      const response = await suite().request("/wagering/transactions", {
        method: "POST",
        headers: { "Idempotency-Key": "k-1" },
        body: '{"providerId": ',
      });
      expectApiError(response, 400, "INVALID_PAYLOAD");
    });
  });

  test("404 WALLET_NOT_FOUND and nothing persisted", async () => {
    const wallet = await createWalletViaApi(suite(), "100.00");
    const ghost = Bun.randomUUIDv7();
    const response = await submitViaApi(suite(), wagerRequest(wallet, "BET", { walletId: ghost }));
    expectApiError(response, 404, "WALLET_NOT_FOUND");
    expect(await transactionRows(suite().sql, ghost)).toEqual([]);
  });

  describe("queries", () => {
    test("GET by id and by provider + externalTransactionId (REJECTED is still a 200 query)", async () => {
      const wallet = await createWalletViaApi(suite(), "10.00");
      const request = wagerRequest(wallet, "BET", { amount: "50.00" });
      const submitted = result((await submitViaApi(suite(), request)).body);
      const expected: Omit<TransactionView, "createdAt"> = {
        transactionId: submitted.transactionId,
        providerId: String(request.body["providerId"]),
        externalTransactionId: String(request.body["externalTransactionId"]),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: { amount: "50.00", currency: "BRL" },
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InsufficientFunds,
        balance: { amount: "10.00", currency: "BRL" },
      };

      const byId = await suite().request(`/wagering/transactions/${submitted.transactionId}`);
      expect(byId.status).toBe(200);
      const { createdAt } = byId.body as TransactionView;
      expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
      expect(byId.body).toEqual({ ...expected, createdAt });

      const byExternal = await suite().request(
        `/providers/${String(request.body["providerId"])}/wagering/transactions/${String(request.body["externalTransactionId"])}`,
      );
      expect(byExternal.status).toBe(200);
      expect(byExternal.body).toEqual(byId.body);
      await assertLedgerInvariant(suite().sql, wallet.id);
    });

    test("404 TRANSACTION_NOT_FOUND (by id, by external id, and for another provider)", async () => {
      const wallet = await createWalletViaApi(suite(), "100.00");
      const request = wagerRequest(wallet, "BET");
      await submitViaApi(suite(), request);
      const externalId = String(request.body["externalTransactionId"]);
      expectApiError(
        await suite().request(`/wagering/transactions/${Bun.randomUUIDv7()}`),
        404,
        "TRANSACTION_NOT_FOUND",
      );
      expectApiError(
        await suite().request(`/providers/provider-a/wagering/transactions/missing-${externalId}`),
        404,
        "TRANSACTION_NOT_FOUND",
      );
      expectApiError(
        await suite().request(`/providers/provider-b/wagering/transactions/${externalId}`),
        404,
        "TRANSACTION_NOT_FOUND",
      );
    });
  });

  test("503 TRANSIENT_FAILURE with Retry-After while the wallet lock is held; the resend succeeds once", async () => {
    const { sql } = suite();
    const wallet = await createWalletViaApi(suite(), "100.00");
    // Another instance with a short lock_timeout: every attempt fails with 55P03.
    const impatient = await suite().open({ lockTimeoutMs: 100 });
    const request = wagerRequest(wallet, "BET", { amount: "30.00" });

    const lock = await holdWalletLock(sql, wallet.id);
    let unavailable;
    try {
      unavailable = await submitViaApi(impatient, request, { "X-Correlation-Id": "busy-wallet" });
    } finally {
      await lock.release();
    }
    expectApiError(unavailable, 503, "TRANSIENT_FAILURE");
    expect(unavailable.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
    expect(await transactionRows(sql, wallet.id)).toHaveLength(1); // only the OPENING

    const resent = await submitViaApi(impatient, request);
    expect(resent.status).toBe(200);
    expect(result(resent.body)).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "70.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect((await ledgerRows(sql, wallet.id)).filter((e) => e.direction === "DEBIT")).toHaveLength(
      1,
    );
    await assertLedgerInvariant(sql, wallet.id);
  });
});
