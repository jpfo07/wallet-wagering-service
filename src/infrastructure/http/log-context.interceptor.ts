import { Observable } from "rxjs";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { logContext } from "../observability/log-context.ts";
import type { HttpRequest } from "./request-context.decorator.ts";

/**
 * Opens the log context of the request around the handler. It cannot be opened in the
 * correlation middleware: the body parser resumes on stream events, outside that async context.
 * Subscribing inside `run` makes the handler (and the use case under it) inherit the context.
 */
export class LogContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const principal = request.principal;
    return new Observable((subscriber) =>
      logContext.run(
        {
          correlationId: request.correlationId,
          providerId: principal?.kind === "provider" ? principal.providerId : undefined,
        },
        () => next.handle().subscribe(subscriber),
      ),
    );
  }
}
