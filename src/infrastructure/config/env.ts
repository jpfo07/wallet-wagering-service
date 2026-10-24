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
}

export interface SqsConfig {
  /** Explicit endpoint (LocalStack / MiniStack). Undefined means real AWS. */
  readonly endpoint: string | undefined;
  readonly region: string;
  readonly wagerQueueName: string;
  readonly wagerDlqName: string;
  readonly eventsQueueName: string;
}

export interface AppConfig {
  readonly instanceId: string;
  readonly httpPort: number;
  /** Internal health port of worker processes. */
  readonly workerHealthPort: number;
  readonly database: DatabaseConfig;
  readonly sqs: SqsConfig;
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

export function loadConfig(source: Source = process.env): AppConfig {
  const endpoint = source["SQS_ENDPOINT"];
  return {
    instanceId: str(source, "INSTANCE_ID", hostname()),
    httpPort: int(source, "HTTP_PORT", 3000),
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
    },
    sqs: {
      endpoint: endpoint === undefined || endpoint === "" ? undefined : endpoint,
      region: str(source, "AWS_REGION", "us-east-1"),
      wagerQueueName: str(source, "SQS_WAGER_QUEUE_NAME", "wager-transactions.fifo"),
      wagerDlqName: str(source, "SQS_WAGER_DLQ_NAME", "wager-transactions-dlq.fifo"),
      eventsQueueName: str(source, "SQS_EVENTS_QUEUE_NAME", "wallet-events.fifo"),
    },
  };
}
