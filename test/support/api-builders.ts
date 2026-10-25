import { expect } from "bun:test";
import type { WalletView } from "../../src/application/views.ts";
import type { ApiHandle, ApiResponse } from "./api-suite.ts";
import { wagerCommand } from "./command-builders.ts";
import type { WagerKind, WagerOverrides } from "./command-builders.ts";

export async function createWalletViaApi(api: ApiHandle, balance = "100.00"): Promise<WalletView> {
  const response = await api.request("/wallets", {
    method: "POST",
    body: { playerId: Bun.randomUUIDv7(), initialBalance: { amount: balance, currency: "BRL" } },
  });
  expect(response.status).toBe(201);
  return response.body as WalletView;
}

export interface WagerRequest {
  readonly idempotencyKey: string;
  readonly body: Record<string, unknown>;
}

/** HTTP form of a valid command: the key goes to the header, everything else to the body. */
export function wagerRequest(
  wallet: WalletView,
  kind: WagerKind,
  overrides: WagerOverrides = {},
): WagerRequest {
  const { idempotencyKey, ...body } = wagerCommand(wallet, kind, overrides);
  return { idempotencyKey, body };
}

export function submitViaApi(
  api: ApiHandle,
  request: WagerRequest,
  headers: Readonly<Record<string, string>> = {},
): Promise<ApiResponse> {
  return api.request("/wagering/transactions", {
    method: "POST",
    headers: { "Idempotency-Key": request.idempotencyKey, ...headers },
    body: request.body,
  });
}

/** The single error format: code, message and the same correlationId as the response header. */
export function expectApiError(response: ApiResponse, status: number, error: string): void {
  expect({ status: response.status, body: response.body }).toMatchObject({
    status,
    body: { error },
  });
  const body = response.body as Record<string, unknown>;
  expect(typeof body["message"]).toBe("string");
  expect(body["correlationId"]).toBe(response.headers.get("x-correlation-id"));
  for (const key of Object.keys(body)) expect(ERROR_BODY_KEYS.has(key)).toBe(true);
}

const ERROR_BODY_KEYS: ReadonlySet<string> = new Set([
  "error",
  "message",
  "correlationId",
  "transactionId",
  "details",
]);
