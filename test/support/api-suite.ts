import { afterAll, beforeAll } from "bun:test";
import { MikroORM } from "@mikro-orm/core";
import type { MikroORM as PostgreSqlMikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SQL } from "bun";
import { APPLICATION } from "../../src/infrastructure/application/application.module.ts";
import { buildApplication } from "../../src/infrastructure/application/composition.ts";
import { APP_CONFIG } from "../../src/infrastructure/config/config.module.ts";
import type { AppConfig, DatabaseConfig } from "../../src/infrastructure/config/env.ts";
import { ApiModule } from "../../src/infrastructure/http/api.module.ts";
import { configureApiApp } from "../../src/infrastructure/http/create-api-app.ts";
import { SilentLogger } from "../../src/infrastructure/observability/telemetry-adapters.ts";
import { createIsolatedDatabase, openSql } from "./database.ts";
import type { IsolatedDatabase } from "./database.ts";
import {
  TEST_PENDING_REFERENCE,
  TEST_SQS_CONSUMER,
  TEST_TRANSIENT_RETRY,
  testSqsConfig,
} from "./test-env.ts";

export interface ApiHandle {
  readonly baseUrl: string;
  /** fetch against this instance; JSON body is serialized when given as an object. */
  request(path: string, init?: ApiRequestInit): Promise<ApiResponse>;
}

export interface ApiRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Object → JSON; string → sent as is (malformed JSON tests). */
  readonly body?: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface ApiSuite extends ApiHandle {
  readonly db: IsolatedDatabase;
  readonly sql: SQL;
  /** Another API instance on the same database (e.g. with a short lock_timeout). */
  open(database?: Partial<DatabaseConfig>): Promise<ApiHandle>;
}

export const RETRY_AFTER_SECONDS = 7;

/**
 * The real ApiModule (controllers, pipes, filter, use cases, MikroORM, SQS client) on one
 * isolated database and the LocalStack of the test stack, served over real HTTP on a free port.
 * Only the logger is silenced.
 */
export function useApiSuite(name: string): () => ApiSuite {
  let suite: ApiSuite | undefined;
  const apps: INestApplication[] = [];

  async function start(db: IsolatedDatabase, database: Partial<DatabaseConfig>) {
    const config: AppConfig = {
      instanceId: `api-test-${apps.length + 1}`,
      httpPort: 0,
      httpRetryAfterSeconds: RETRY_AFTER_SECONDS,
      workerHealthPort: 0,
      database: { ...db.config, ...database },
      sqs: testSqsConfig(),
      transientRetry: TEST_TRANSIENT_RETRY,
      pendingReference: TEST_PENDING_REFERENCE,
      sqsConsumer: TEST_SQS_CONSUMER,
    };
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(APPLICATION)
      .useFactory({
        inject: [MikroORM, APP_CONFIG],
        factory: (orm: PostgreSqlMikroORM, appConfig: AppConfig) =>
          buildApplication(orm, appConfig, { logger: new SilentLogger() }),
      })
      .compile();
    const app = configureApiApp(moduleRef.createNestApplication({ logger: false }));
    apps.push(app);
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    return handle(baseUrl);
  }

  beforeAll(async () => {
    const db = await createIsolatedDatabase(name);
    const sql = openSql(db.name, 4);
    const main = await start(db, {});
    suite = { ...main, db, sql, open: (database = {}) => start(db, database) };
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
    await suite?.sql.close();
    await suite?.db.drop();
  });

  return () => {
    if (suite === undefined) throw new Error("api suite not initialized");
    return suite;
  };
}

function handle(baseUrl: string): ApiHandle {
  return {
    baseUrl,
    async request(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      let body: string | undefined;
      if (typeof init.body === "string") {
        body = init.body;
        headers["content-type"] ??= "application/json";
      } else if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        headers["content-type"] ??= "application/json";
      }
      const response = await fetch(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: text === "" ? undefined : (JSON.parse(text) as unknown),
      };
    },
  };
}
