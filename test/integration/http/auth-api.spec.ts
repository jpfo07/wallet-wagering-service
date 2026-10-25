import { describe, expect, test } from "bun:test";
import { UnauthenticatedError } from "../../../src/application/errors.ts";
import type {
  ProviderCredentials,
  ProviderIdentityPort,
  ProviderPrincipal,
} from "../../../src/application/ports/provider-identity.ts";
import type { WalletView } from "../../../src/application/views.ts";
import { expectApiError, submitViaApi, wagerRequest } from "../../support/api-builders.ts";
import { useApiSuite } from "../../support/api-suite.ts";
import { transactionRows } from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";

/** Stand-in for an OIDC adapter: "Bearer <providerId>" authenticates as that provider. */
class BearerIsProvider implements ProviderIdentityPort {
  readonly seen: ProviderCredentials[] = [];

  resolve(credentials: ProviderCredentials): Promise<ProviderPrincipal> {
    this.seen.push(credentials);
    const match = /^Bearer (.+)$/.exec(credentials.authorization ?? "");
    if (match?.[1] === undefined) return Promise.reject(new UnauthenticatedError());
    return Promise.resolve({ kind: "provider", providerId: match[1] });
  }
}

describe("HTTP API — AuthGuard and ProviderIdentityPort (real app, PostgreSQL, LocalStack)", () => {
  const identity = new BearerIsProvider();
  const suite = useApiSuite("api-auth", { identity });
  const asAdmin = { Authorization: "Bearer test-provider" };

  test("health and metrics stay open; every other route goes through the guard (401)", async () => {
    const seenBefore = identity.seen.length;
    for (const path of ["/health/live", "/health/ready", "/metrics"]) {
      expect((await fetch(`${suite().baseUrl}${path}`)).status).toBe(200);
    }
    expect(identity.seen.length).toBe(seenBefore);

    expectApiError(
      await suite().request("/wallets", {
        method: "POST",
        body: { playerId: Bun.randomUUIDv7(), initialBalance: { amount: "1.00", currency: "BRL" } },
      }),
      401,
      "UNAUTHENTICATED",
    );
    expectApiError(await suite().request(`/wallets/${Bun.randomUUIDv7()}`), 401, "UNAUTHENTICATED");
  });

  test("a provider acting on another providerId gets 403 and nothing is stored", async () => {
    const wallet = await authenticatedWallet();
    const request = wagerRequest(wallet, "BET", { providerId: "other-provider" });
    const response = await submitViaApi(suite(), request, { Authorization: "Bearer p1" });
    expectApiError(response, 403, "PROVIDER_IDENTITY_MISMATCH");
    expect(await transactionRows(suite().sql, wallet.id)).toHaveLength(1); // only the OPENING
    await assertLedgerInvariant(suite().sql, wallet.id);
  });

  test("the matching provider is accepted, and may only read its own transactions", async () => {
    const wallet = await authenticatedWallet();
    const request = wagerRequest(wallet, "BET", { providerId: "p1" });
    expect((await submitViaApi(suite(), request, { Authorization: "Bearer p1" })).status).toBe(200);

    const path = `/providers/p1/wagering/transactions/${String(request.body["externalTransactionId"])}`;
    expect((await suite().request(path, { headers: { Authorization: "Bearer p1" } })).status).toBe(
      200,
    );
    expectApiError(
      await suite().request(path, { headers: { Authorization: "Bearer p2" } }),
      403,
      "PROVIDER_IDENTITY_MISMATCH",
    );
    await assertLedgerInvariant(suite().sql, wallet.id);
  });

  async function authenticatedWallet(): Promise<WalletView> {
    const response = await suite().request("/wallets", {
      method: "POST",
      headers: asAdmin,
      body: { playerId: Bun.randomUUIDv7(), initialBalance: { amount: "100.00", currency: "BRL" } },
    });
    expect(response.status).toBe(201);
    return response.body as WalletView;
  }
});
