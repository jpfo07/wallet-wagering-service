import type {
  DatabaseConfig,
  PendingReferenceConfig,
  SqsConfig,
  SqsConsumerConfig,
  TransientRetryConfig,
} from "../../src/infrastructure/config/env.ts";

/** The env.ts defaults, except a shorter retry backoff so retries do not slow tests down. */
export const TEST_TRANSIENT_RETRY: TransientRetryConfig = { maxAttempts: 3, baseMs: 10, maxMs: 40 };
export const TEST_PENDING_REFERENCE: PendingReferenceConfig = {
  baseMs: 1_000,
  maxMs: 60_000,
  ttlMs: 900_000,
};

/** Consumer settings for tests: short polls, drain and backoffs, so nothing waits for seconds. */
export const TEST_SQS_CONSUMER: SqsConsumerConfig = {
  concurrency: 4,
  waitTimeSeconds: 1,
  retryBaseMs: 1_000,
  retryMaxMs: 2_000,
  shutdownDrainMs: 2_000,
  processingMarginMs: 10_000,
  databaseProbeTimeoutMs: 500,
  databaseProbeFreshnessMs: 500,
  databasePauseBaseMs: 100,
  databasePauseMaxMs: 500,
};

/** Connection data of the test stack (docker-compose.test.yml). Never reads DATABASE_* vars. */
export const testInfra = {
  dbHost: process.env["TEST_DATABASE_HOST"] ?? "localhost",
  dbPort: Number(process.env["TEST_DATABASE_PORT"] ?? "55432"),
  dbUser: process.env["TEST_DATABASE_USER"] ?? "wallet",
  dbPassword: process.env["TEST_DATABASE_PASSWORD"] ?? "wallet",
  sqsEndpoint: process.env["TEST_SQS_ENDPOINT"] ?? "http://localhost:54566",
  /** Host LocalStack writes into queue URLs (LOCALSTACK_HOST): the compose-network name. */
  sqsQueueUrlBase: process.env["TEST_SQS_QUEUE_URL_BASE"] ?? "http://localstack:4566",
  region: process.env["AWS_REGION"] ?? "us-east-1",
} as const;

export function testDatabaseConfig(
  name: string,
  overrides: Partial<DatabaseConfig> = {},
): DatabaseConfig {
  return {
    host: testInfra.dbHost,
    port: testInfra.dbPort,
    name,
    user: testInfra.dbUser,
    password: testInfra.dbPassword,
    poolMax: 5,
    lockTimeoutMs: 5000,
    statementTimeoutMs: 15000,
    ...overrides,
  };
}

export function testSqsConfig(overrides: Partial<SqsConfig> = {}): SqsConfig {
  return {
    endpoint: testInfra.sqsEndpoint,
    region: testInfra.region,
    wagerQueueName: "wager-transactions.fifo",
    wagerDlqName: "wager-transactions-dlq.fifo",
    eventsQueueName: "wallet-events.fifo",
    ...overrides,
  };
}

/** Environment for child processes (Bun.spawn) pointing at the given database. */
export function childProcessEnv(
  db: DatabaseConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    DATABASE_HOST: db.host,
    DATABASE_PORT: String(db.port),
    DATABASE_NAME: db.name,
    DATABASE_USER: db.user,
    DATABASE_PASSWORD: db.password,
    DATABASE_POOL_MAX: String(db.poolMax),
    SQS_ENDPOINT: testInfra.sqsEndpoint,
    AWS_REGION: testInfra.region,
    AWS_ACCESS_KEY_ID: process.env["AWS_ACCESS_KEY_ID"] ?? "test",
    AWS_SECRET_ACCESS_KEY: process.env["AWS_SECRET_ACCESS_KEY"] ?? "test",
    ...extra,
  };
}
