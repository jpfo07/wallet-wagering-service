import type {
  ProviderIdentityPort,
  ProviderPrincipal,
} from "../../application/ports/provider-identity.ts";

/**
 * This delivery has no identity provider (see ARCHITECTURE.md, "Autenticação"): every caller is
 * `unverified`, so no providerId is restricted. Swapping this for an OIDC adapter is the only
 * change needed to enforce provider identity.
 */
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  resolve(): Promise<ProviderPrincipal> {
    return Promise.resolve({ kind: "unverified" });
  }
}
