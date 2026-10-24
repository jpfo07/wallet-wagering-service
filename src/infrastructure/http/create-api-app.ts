import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ApiModule } from "./api.module.ts";

interface HeaderWritable {
  setHeader(name: string, value: string): void;
}

/** Builds the HTTP application. Shared by the entrypoint and the tests. */
export async function createApiApp(instanceId: string): Promise<INestApplication> {
  const app = await NestFactory.create(ApiModule, { logger: ["error", "warn", "log"] });
  app.use((_req: unknown, res: HeaderWritable, next: () => void) => {
    res.setHeader("X-Instance-Id", instanceId);
    next();
  });
  return app;
}
