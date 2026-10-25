import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { ProviderPrincipal } from "../../application/ports/provider-identity.ts";
import type { RequestContext } from "../../application/request-context.ts";

/** The request as the HTTP adapter sees it (Express, structurally). */
export interface HttpRequest {
  readonly method: string;
  readonly originalUrl: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Set by the correlation middleware before anything else runs. */
  correlationId?: string;
  /** Set by the AuthGuard on every non-public route. */
  principal?: ProviderPrincipal;
}

export interface HttpResponse {
  readonly statusCode: number;
  on(event: "finish", listener: () => void): unknown;
  status(code: number): HttpResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

/**
 * One request header by name (lowercase), as a parameter that accepts pipes — Nest's @Headers()
 * does not run pipes on a single header.
 */
export const RequestHeader = createParamDecorator(
  (name: string, host: ExecutionContext): string | string[] | undefined =>
    host.switchToHttp().getRequest<HttpRequest>().headers[name],
);

/**
 * RequestContext of the use cases: the correlation id resolved by the middleware and the principal
 * resolved by the AuthGuard.
 */
export const Ctx = createParamDecorator(
  (_data: unknown, host: ExecutionContext): RequestContext => {
    const { correlationId, principal } = host.switchToHttp().getRequest<HttpRequest>();
    if (correlationId === undefined) {
      throw new Error("correlation middleware not installed (configureApiApp)");
    }
    if (principal === undefined) throw new Error("AuthGuard not installed (AuthModule)");
    return { correlationId, principal };
  },
);
