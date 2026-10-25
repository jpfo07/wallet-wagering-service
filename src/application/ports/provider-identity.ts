import { ProviderIdentityMismatchError } from "../errors.ts";

/**
 * Who is calling, as far as the application cares:
 * - `provider`: a credential proved this providerId (e.g. a validated JWT claim);
 * - `unverified`: HTTP without an identity provider (this delivery's no-op adapter);
 * - `internal-channel`: the SQS queue, a trusted internal channel.
 * Only `provider` restricts anything; the providerId of every request still goes through the
 * same domain validations whatever the principal.
 */
export type ProviderPrincipal =
  | { readonly kind: "provider"; readonly providerId: string }
  | { readonly kind: "unverified" }
  | { readonly kind: "internal-channel" };

/** What the transport hands to the identity adapter; never logged. */
export interface ProviderCredentials {
  readonly authorization?: string | undefined;
}

/**
 * Extension point of authentication: resolves the caller from its credentials, or throws
 * UnauthenticatedError. The no-op adapter answers `unverified`; an OIDC adapter (JWT validated
 * against the IdP's JWKS) answers `provider` from a claim, without touching any use case.
 */
export interface ProviderIdentityPort {
  resolve(credentials: ProviderCredentials): Promise<ProviderPrincipal>;
}

/** An authenticated provider may only act on its own providerId. */
export function assertActsAsProvider(
  principal: ProviderPrincipal | undefined,
  providerId: string,
): void {
  if (principal?.kind === "provider" && principal.providerId !== providerId) {
    throw new ProviderIdentityMismatchError(principal.providerId, providerId);
  }
}
