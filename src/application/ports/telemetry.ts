export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Structured logger. Fields are identifiers only, never full financial payloads. */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Counters the use cases report. The Prometheus adapter comes with the observability phase. */
export interface ApplicationMetrics {
  transientRetry(reason: string): void;
  idempotentReplay(): void;
  idempotencyConflict(): void;
  reconciliationDivergence(): void;
}
