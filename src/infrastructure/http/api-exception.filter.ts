import { Catch, HttpException } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { IdGenerator } from "../../application/ports/system.ts";
import type { Logger } from "../../application/ports/telemetry.ts";
import { CORRELATION_ID_HEADER, resolveCorrelationId } from "./correlation-id.ts";
import { mapError } from "./http-errors.ts";
import type { ApiErrorBody } from "./http-errors.ts";
import type { HttpRequest, HttpResponse } from "./request-context.decorator.ts";

/** Every error of every endpoint leaves through here, in the one error format (http-errors.ts). */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly ids: IdGenerator,
    private readonly retryAfterSeconds: number,
  ) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    // The middleware already resolved it; the fallback covers a failure before it ran.
    const correlationId =
      request.correlationId ??
      resolveCorrelationId(request.headers[CORRELATION_ID_HEADER.toLowerCase()], this.ids);

    const mapped = mapError(
      error,
      error instanceof HttpException
        ? { status: error.getStatus(), message: error.message }
        : undefined,
    );
    if (mapped.log !== "none") {
      this.logger[mapped.log]("request failed", {
        status: mapped.status,
        error: mapped.body.error,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : undefined,
        method: request.method,
        path: request.originalUrl.split("?")[0],
        correlationId,
      });
    }

    const body: ApiErrorBody = { ...mapped.body, correlationId };
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    if (mapped.retryable) response.setHeader("Retry-After", String(this.retryAfterSeconds));
    response.status(mapped.status).json(body);
  }
}
