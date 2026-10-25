import { describe, expect, test } from "bun:test";
import type { WagerTransactionResult } from "../../../src/application/views.ts";
import { createWalletViaApi, submitViaApi, wagerRequest } from "../../support/api-builders.ts";
import { useApiSuite } from "../../support/api-suite.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { holdWalletLock } from "../../support/lock-barrier.ts";
import { LogCapture } from "../../support/log-capture.ts";

// Distinctive values: none of them may show up anywhere in the logs.
const OPENING = "731.29";
const STAKE = "48.17";
const REMAINING = "683.12";
const SECRET = "Bearer s3cr3t-provider-token";

describe("HTTP API — logs and /metrics (real app, PostgreSQL, LocalStack)", () => {
  const logs = new LogCapture();
  const suite = useApiSuite("api-observability", { logDestination: logs });

  test("logs carry the identifiers and never money values or credentials", async () => {
    const wallet = await createWalletViaApi(suite(), OPENING);
    const request = wagerRequest(wallet, "BET", { amount: STAKE });
    const response = await submitViaApi(suite(), request, {
      "X-Correlation-Id": "corr-observability-1",
      Authorization: SECRET,
    });
    expect(response.status).toBe(200);
    const { transactionId } = response.body as WagerTransactionResult;

    const handled = logs.find(
      "wager transaction handled",
      (l) => l["transactionId"] === transactionId,
    );
    expect(handled).toMatchObject({
      level: "info",
      process: "api",
      correlationId: "corr-observability-1",
      transactionId,
      walletId: wallet.id,
      providerId: request.body["providerId"],
    });
    expect(typeof handled?.["time"]).toBe("string");
    expect(typeof handled?.["instanceId"]).toBe("string");

    const access = logs.find(
      "http request",
      (l) => l["correlationId"] === "corr-observability-1" && l["method"] === "POST",
    );
    expect(access).toMatchObject({ path: "/wagering/transactions", status: 200 });
    expect(access).not.toHaveProperty("headers");
    expect(access).not.toHaveProperty("body");

    const text = logs.text();
    for (const value of [OPENING, STAKE, REMAINING, "s3cr3t-provider-token"]) {
      expect(text).not.toContain(value);
    }
    await assertLedgerInvariant(suite().sql, wallet.id);
  });

  test("logs inside the use case inherit the request context (transient retry on a held lock)", async () => {
    const { sql } = suite();
    const wallet = await createWalletViaApi(suite(), "100.00");
    const impatient = await suite().open({ lockTimeoutMs: 100 });
    const lock = await holdWalletLock(sql, wallet.id);
    try {
      const response = await submitViaApi(impatient, wagerRequest(wallet, "BET"), {
        "X-Correlation-Id": "corr-observability-busy",
      });
      expect(response.status).toBe(503);
    } finally {
      await lock.release();
    }
    // TransactionRunner logs only the reason; the correlationId comes from the log context.
    const retry = logs.find(
      "transient persistence error, retrying",
      (l) => l["correlationId"] === "corr-observability-busy",
    );
    expect(retry).toMatchObject({ level: "warn", reason: "55P03" });

    const metrics = await (await fetch(`${impatient.baseUrl}/metrics`)).text();
    expect(metrics).toMatch(/wws_lock_conflicts_total\{reason="lock_timeout",[^}]*\} [1-9]/);
    expect(metrics).toMatch(
      /wws_retries_total\{component="transaction",reason="55P03",[^}]*\} [1-9]/,
    );
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("/metrics is open and exposes transactions, duplicates, latency and lock wait", async () => {
    const wallet = await createWalletViaApi(suite(), "100.00");
    const request = wagerRequest(wallet, "BET", { amount: "10.00" });
    expect((await submitViaApi(suite(), request)).status).toBe(200);
    expect((await submitViaApi(suite(), request)).status).toBe(200); // replay

    const response = await fetch(`${suite().baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const metrics = await response.text();
    expect(metrics).toMatch(
      /wws_wager_transactions_total\{kind="BET",status="PROCESSED",source="http",[^}]*\} [1-9]/,
    );
    expect(metrics).toMatch(/wws_duplicates_total\{type="replay",[^}]*\} [1-9]/);
    expect(metrics).toMatch(
      /wws_wager_processing_duration_seconds_bucket\{[^}]*kind="BET",source="http",outcome="REPLAY"/,
    );
    expect(metrics).toMatch(/wws_wallet_lock_wait_seconds_count\{[^}]*\} [1-9]/);
    // Health and scrapes are not request-logged.
    expect(logs.find("http request", (l) => l["path"] === "/metrics")).toBeUndefined();
    await assertLedgerInvariant(suite().sql, wallet.id);
  });
});
