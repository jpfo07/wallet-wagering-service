import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { RequestContext } from "../../application/request-context.ts";

/** The request as the HTTP adapter sees it (Express, structurally). */
export interface HttpRequest {
  readonly method: string;
  readonly originalUrl: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Set by the correlation middleware before anything else runs. */
  correlationId?: string;
}

export interface HttpResponse {
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

/** RequestContext of the use cases, built from the correlation id resolved by the middleware. */
export const Ctx = createParamDecorator(
  (_data: unknown, host: ExecutionContext): RequestContext => {
    const correlationId = host.switchToHttp().getRequest<HttpRequest>().correlationId;
    if (correlationId === undefined) {
      throw new Error("correlation middleware not installed (configureApiApp)");
    }
    return { correlationId };
  },
);
