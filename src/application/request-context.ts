import type { ProviderPrincipal } from "./ports/provider-identity.ts";

/** Tracing identifiers carried from the entrypoint (HTTP request or SQS message) into the events. */
export interface RequestContext {
  readonly correlationId: string;
  /** What caused this request (the SQS messageId), copied into the events. */
  readonly causationId?: string | undefined;
  /** Who is calling (see ProviderIdentityPort); absent means no restriction. */
  readonly principal?: ProviderPrincipal | undefined;
}
