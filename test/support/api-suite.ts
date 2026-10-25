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
import type { DestinationStream } from "pino";
import type { ProviderIdentityPort } from "../../src/application/ports/provider-identity.ts";
import { PROVIDER_IDENTITY } from "../../src/infrastructure/auth/auth.guard.ts";
import { PROCESS_TELEMETRY } from "../../src/infrastructure/observability/observability.module.ts";
import { createProcessTelemetry } from "../../src/infrastructure/observability/process-telemetry.ts";
import type { ProcessTelemetry } from "../../src/infrastructure/observability/process-telemetry.ts";
import { NoopProviderIdentityAdapter } from "../../src/infrastructure/auth/noop-provider-identity.adapter.ts";
import { createIsolatedDatabase, openSql } from "./database.ts";
import type { IsolatedDatabase } from "./database.ts";
import {
  TEST_PENDING_REFERENCE,
  TEST_SQS_CONSUMER,
  TEST_OUTBOX_PUBLISHER,
  TEST_PENDING_REFERENCE_WORKER,
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

export interface ApiSuiteOptions {
  /** Where the pino logger writes (default: discarded). */
  readonly logDestination?: DestinationStream;
  /** Identity adapter behind the AuthGuard (default: the no-op one). */
  readonly identity?: ProviderIdentityPort;
}

const DISCARD: DestinationStream = { write: () => undefined };

/**
 * The real ApiModule (controllers, pipes, filter, guard, use cases, MikroORM, SQS client) on one
 * isolated database and the LocalStack of the test stack, served over real HTTP on a free port.
 * Logs are discarded unless a destination is given; process metrics are off.
 */
export function useApiSuite(name: string, options: ApiSuiteOptions = {}): () => ApiSuite {
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
      outboxPublisher: TEST_OUTBOX_PUBLISHER,
      pendingReferenceWorker: TEST_PENDING_REFERENCE_WORKER,
    };
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(PROCESS_TELEMETRY)
      .useValue(
        createProcessTelemetry({
          process: "api",
          instanceId: config.instanceId,
          defaultMetrics: false,
          logDestination: options.logDestination ?? DISCARD,
        }),
      )
      .overrideProvider(PROVIDER_IDENTITY)
      .useValue(options.identity ?? new NoopProviderIdentityAdapter())
      .overrideProvider(APPLICATION)
      .useFactory({
        inject: [MikroORM, APP_CONFIG, PROCESS_TELEMETRY],
        factory: (orm: PostgreSqlMikroORM, appConfig: AppConfig, telemetry: ProcessTelemetry) =>
          buildApplication(orm, appConfig, {
            logger: telemetry.logger,
            metrics: telemetry.metrics,
          }),
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
