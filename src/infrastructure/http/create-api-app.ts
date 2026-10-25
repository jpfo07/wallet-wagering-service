import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { APPLICATION } from "../application/application.module.ts";
import type { Application } from "../application/composition.ts";
import { APP_CONFIG } from "../config/config.module.ts";
import type { AppConfig } from "../config/env.ts";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { ApiModule } from "./api.module.ts";
import { CORRELATION_ID_HEADER, resolveCorrelationId } from "./correlation-id.ts";
import type { HttpRequest, HttpResponse } from "./request-context.decorator.ts";

/**
 * Everything the HTTP edge adds on top of the module, shared by the entrypoint and the API tests:
 * instance and correlation headers on every response (errors and unknown routes included) and the
 * single error format. The middleware is registered before Nest's own (body parser, router), so
 * it runs first for every request.
 */
export function configureApiApp(app: INestApplication): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);
  const { logger, ids } = app.get<Application>(APPLICATION).dependencies;
  app.use((request: HttpRequest, response: HttpResponse, next: () => void) => {
    const correlationId = resolveCorrelationId(
      request.headers[CORRELATION_ID_HEADER.toLowerCase()],
      ids,
    );
    request.correlationId = correlationId;
    response.setHeader("X-Instance-Id", config.instanceId);
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  });
  app.useGlobalFilters(new ApiExceptionFilter(logger, ids, config.httpRetryAfterSeconds));
  return app;
}

/** Builds the HTTP application of the entrypoint. */
export async function createApiApp(): Promise<INestApplication> {
  const app = await NestFactory.create(ApiModule, { logger: ["error", "warn", "log"] });
  return configureApiApp(app);
}
