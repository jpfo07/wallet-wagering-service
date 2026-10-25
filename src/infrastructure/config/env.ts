import { hostname } from "node:os";

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly name: string;
  readonly user: string;
  readonly password: string;
  readonly poolMax: number;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  /**
   * idle_in_transaction_session_timeout: PostgreSQL ends a session that keeps a transaction open
   * without running statements for this long, releasing its locks. Bounds the damage of a hung
   * outbox publisher (it holds row locks while it talks to SQS).
   */
  readonly idleInTransactionTimeoutMs: number;
}

export interface SqsConfig {
  /** Explicit endpoint (LocalStack / MiniStack). Undefined means real AWS. */
  readonly endpoint: string | undefined;
  readonly region: string;
  readonly wagerQueueName: string;
  readonly wagerDlqName: string;
  readonly eventsQueueName: string;
}

/** Bounded retry of transient database errors (lock timeout, deadlock, lost connection...). */
export interface TransientRetryConfig {
  /** Total attempts, including the first. */
  readonly maxAttempts: number;
  readonly baseMs: number;
  readonly maxMs: number;
}

/** How long a transaction waits for its reference (decision 14): exponential backoff + TTL. */
export interface PendingReferenceConfig {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly ttlMs: number;
}

/** SQS consumer of wager-transactions.fifo (see ARCHITECTURE.md, section 12). */
export interface SqsConsumerConfig {
  /** Messages in flight per process. */
  readonly concurrency: number;
  /**
   * Long polling wait (0 to 20 s). Short on purpose: SIGTERM waits for the poll in progress
   * instead of aborting it (an aborted poll stays open on the server and steals messages).
   */
  readonly waitTimeSeconds: number;
  /** Visibility backoff of a retried message, by ApproximateReceiveCount. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** How long SIGTERM waits for in-flight messages before giving their visibility back. */
  readonly shutdownDrainMs: number;
  /** Margin over the computed worst case that the queue VisibilityTimeout must also cover. */
  readonly processingMarginMs: number;
  /** Database gate: probe timeout, how long a healthy check stays fresh, pause backoff. */
  readonly databaseProbeTimeoutMs: number;
  readonly databaseProbeFreshnessMs: number;
  readonly databasePauseBaseMs: number;
  readonly databasePauseMaxMs: number;
}

/** Outbox publisher (see ARCHITECTURE.md, section 13). */
export interface OutboxPublisherConfig {
  /** Aggregates (wallets) claimed per batch: one locked head event each. */
  readonly batchAggregates: number;
  /** Events of one aggregate published per batch, in order. */
  readonly maxEventsPerAggregate: number;
  readonly pollIntervalMs: number;
  /** Backoff of an event whose publication failed. There is no attempt limit. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** Timeout of each SQS request; must stay below idleInTransactionTimeoutMs. */
  readonly sqsRequestTimeoutMs: number;
  /** Pause after a failed batch (database down...). */
  readonly errorPauseBaseMs: number;
  readonly errorPauseMaxMs: number;
}

/** Worker that re-checks PENDING_REFERENCE transactions. */
export interface PendingReferenceWorkerConfig {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly errorPauseBaseMs: number;
  readonly errorPauseMaxMs: number;
}

export interface AppConfig {
  readonly instanceId: string;
  readonly httpPort: number;
  /** Retry-After (seconds) of a 503 caused by a transient infrastructure failure. */
  readonly httpRetryAfterSeconds: number;
  /**
   * On SIGTERM, how long an API replica keeps answering (with `Connection: close`, readiness 503)
   * before closing its port: longer than the proxy's upstream keepalive timeout, so every pooled
   * socket to this replica is gone before it closes. 0 outside a proxied deployment.
   */
  readonly httpShutdownDrainMs: number;
  /** Internal health port of worker processes. */
  readonly workerHealthPort: number;
  readonly database: DatabaseConfig;
  readonly sqs: SqsConfig;
  readonly transientRetry: TransientRetryConfig;
  readonly pendingReference: PendingReferenceConfig;
  readonly sqsConsumer: SqsConsumerConfig;
  readonly outboxPublisher: OutboxPublisherConfig;
  readonly pendingReferenceWorker: PendingReferenceWorkerConfig;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Source = Readonly<Record<string, string | undefined>>;

function str(source: Source, key: string, fallback?: string): string {
  const value = source[key];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`Variável de ambiente obrigatória ausente: ${key}`);
}

function int(source: Source, key: string, fallback?: number): number {
  const raw = source[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`Variável de ambiente obrigatória ausente: ${key}`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`Variável ${key} deve ser um inteiro não negativo, recebido "${raw}"`);
  }
  return Number(raw);
}

function atLeastOne(source: Source, key: string, fallback: number): number {
  const value = int(source, key, fallback);
  if (value < 1) throw new ConfigError(`Variável ${key} deve ser maior que zero`);
  return value;
}

function atMost(source: Source, key: string, fallback: number, max: number): number {
  const value = int(source, key, fallback);
  if (value > max) throw new ConfigError(`Variável ${key} deve ser no máximo ${max}`);
  return value;
}

export function loadConfig(source: Source = process.env): AppConfig {
  const endpoint = source["SQS_ENDPOINT"];
  return {
    instanceId: str(source, "INSTANCE_ID", hostname()),
    httpPort: int(source, "HTTP_PORT", 3000),
    httpRetryAfterSeconds: int(source, "HTTP_RETRY_AFTER_SECONDS", 1),
    httpShutdownDrainMs: int(source, "HTTP_SHUTDOWN_DRAIN_MS", 0),
    workerHealthPort: int(source, "WORKER_HEALTH_PORT", 9100),
    database: {
      host: str(source, "DATABASE_HOST"),
      port: int(source, "DATABASE_PORT", 5432),
      name: str(source, "DATABASE_NAME"),
      user: str(source, "DATABASE_USER"),
      password: str(source, "DATABASE_PASSWORD"),
      poolMax: int(source, "DATABASE_POOL_MAX", 10),
      lockTimeoutMs: int(source, "DATABASE_LOCK_TIMEOUT_MS", 5000),
      statementTimeoutMs: int(source, "DATABASE_STATEMENT_TIMEOUT_MS", 15000),
      idleInTransactionTimeoutMs: atLeastOne(
        source,
        "DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS",
        30_000,
      ),
    },
    sqs: {
      endpoint: endpoint === undefined || endpoint === "" ? undefined : endpoint,
      region: str(source, "AWS_REGION", "us-east-1"),
      wagerQueueName: str(source, "SQS_WAGER_QUEUE_NAME", "wager-transactions.fifo"),
      wagerDlqName: str(source, "SQS_WAGER_DLQ_NAME", "wager-transactions-dlq.fifo"),
      eventsQueueName: str(source, "SQS_EVENTS_QUEUE_NAME", "wallet-events.fifo"),
    },
    transientRetry: {
      maxAttempts: int(source, "DATABASE_TRANSIENT_RETRY_ATTEMPTS", 3),
      baseMs: int(source, "DATABASE_TRANSIENT_RETRY_BASE_MS", 50),
      maxMs: int(source, "DATABASE_TRANSIENT_RETRY_MAX_MS", 400),
    },
    pendingReference: {
      baseMs: int(source, "PENDING_REFERENCE_BACKOFF_BASE_MS", 1_000),
      maxMs: int(source, "PENDING_REFERENCE_BACKOFF_MAX_MS", 60_000),
      ttlMs: int(source, "PENDING_REFERENCE_TTL_MS", 900_000),
    },
    sqsConsumer: {
      concurrency: atLeastOne(source, "SQS_CONSUMER_CONCURRENCY", 4),
      waitTimeSeconds: atMost(source, "SQS_WAIT_TIME_SECONDS", 5, 20),
      retryBaseMs: atLeastOne(source, "SQS_RETRY_BACKOFF_BASE_MS", 2_000),
      retryMaxMs: atLeastOne(source, "SQS_RETRY_BACKOFF_MAX_MS", 60_000),
      shutdownDrainMs: int(source, "SQS_SHUTDOWN_DRAIN_MS", 8_000),
      processingMarginMs: int(source, "SQS_PROCESSING_MARGIN_MS", 10_000),
      databaseProbeTimeoutMs: atLeastOne(source, "SQS_DATABASE_PROBE_TIMEOUT_MS", 2_000),
      databaseProbeFreshnessMs: int(source, "SQS_DATABASE_PROBE_FRESHNESS_MS", 2_000),
      databasePauseBaseMs: atLeastOne(source, "SQS_DATABASE_PAUSE_BASE_MS", 1_000),
      databasePauseMaxMs: atLeastOne(source, "SQS_DATABASE_PAUSE_MAX_MS", 30_000),
    },
    outboxPublisher: {
      batchAggregates: atLeastOne(source, "OUTBOX_BATCH_AGGREGATES", 50),
      maxEventsPerAggregate: atLeastOne(source, "OUTBOX_MAX_EVENTS_PER_AGGREGATE", 10),
      pollIntervalMs: atLeastOne(source, "OUTBOX_POLL_INTERVAL_MS", 200),
      retryBaseMs: atLeastOne(source, "OUTBOX_RETRY_BACKOFF_BASE_MS", 1_000),
      retryMaxMs: atLeastOne(source, "OUTBOX_RETRY_BACKOFF_MAX_MS", 60_000),
      sqsRequestTimeoutMs: atLeastOne(source, "OUTBOX_SQS_REQUEST_TIMEOUT_MS", 5_000),
      errorPauseBaseMs: atLeastOne(source, "OUTBOX_ERROR_PAUSE_BASE_MS", 500),
      errorPauseMaxMs: atLeastOne(source, "OUTBOX_ERROR_PAUSE_MAX_MS", 30_000),
    },
    pendingReferenceWorker: {
      batchSize: atLeastOne(source, "PENDING_REFERENCE_BATCH_SIZE", 50),
      pollIntervalMs: atLeastOne(source, "PENDING_REFERENCE_POLL_INTERVAL_MS", 500),
      errorPauseBaseMs: atLeastOne(source, "PENDING_REFERENCE_ERROR_PAUSE_BASE_MS", 500),
      errorPauseMaxMs: atLeastOne(source, "PENDING_REFERENCE_ERROR_PAUSE_MAX_MS", 30_000),
    },
  };
}
