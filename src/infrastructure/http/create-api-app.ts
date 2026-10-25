import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { APPLICATION } from "../application/application.module.ts";
import type { Application } from "../application/composition.ts";
import { APP_CONFIG } from "../config/config.module.ts";
import type { AppConfig } from "../config/env.ts";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { NestLoggerAdapter } from "../observability/nest-logger.adapter.ts";
import { ApiModule } from "./api.module.ts";
import { CORRELATION_ID_HEADER, resolveCorrelationId } from "./correlation-id.ts";
import { HttpDrain } from "./http-drain.ts";
import { LogContextInterceptor } from "./log-context.interceptor.ts";
import type { HttpRequest, HttpResponse } from "./request-context.decorator.ts";

/** Probes and scrapes are not logged: they would drown the request log. */
const UNLOGGED_PATHS = /^\/(health|metrics)(\/|$)/;

/**
 * Everything the HTTP edge adds on top of the module, shared by the entrypoint and the API tests:
 * instance and correlation headers on every response (errors and unknown routes included), one
 * access log line per request, the log context of the handler and the single error format. The
 * middleware is registered before Nest's own (body parser, router), so it runs first for every
 * request.
 */
export function configureApiApp(app: INestApplication): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);
  const { logger, ids } = app.get<Application>(APPLICATION).dependencies;
  const drain = app.get(HttpDrain);
  app.use((request: HttpRequest, response: HttpResponse, next: () => void) => {
    const correlationId = resolveCorrelationId(
      request.headers[CORRELATION_ID_HEADER.toLowerCase()],
      ids,
    );
    request.correlationId = correlationId;
    response.setHeader("X-Instance-Id", config.instanceId);
    if (drain.active) response.setHeader("Connection", "close");
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    // Path without the query string; never the body or the headers.
    const path = request.originalUrl.split("?")[0] ?? "";
    if (!UNLOGGED_PATHS.test(path)) {
      const startedAt = performance.now();
      response.on("finish", () => {
        logger.info("http request", {
          method: request.method,
          path,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
          correlationId,
        });
      });
    }
    next();
  });
  app.useGlobalInterceptors(new LogContextInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter(logger, ids, config.httpRetryAfterSeconds));
  return app;
}

/** Builds the HTTP application of the entrypoint; Nest's own logs go through pino too. */
export async function createApiApp(): Promise<INestApplication> {
  const app = await NestFactory.create(ApiModule, { bufferLogs: true });
  app.useLogger(new NestLoggerAdapter(app.get<Application>(APPLICATION).dependencies.logger));
  return configureApiApp(app);
}
