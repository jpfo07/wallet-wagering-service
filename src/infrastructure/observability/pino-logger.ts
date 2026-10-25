import { pino } from "pino";
import type { DestinationStream, Logger as Pino } from "pino";
import type { LogFields, Logger } from "../../application/ports/telemetry.ts";
import { logContext } from "./log-context.ts";

export const REDACTED = "[REDACTED]";

/**
 * Second barrier against sensitive data (the first is LogFields, which only takes scalars, and the
 * callers, which log identifiers): money values, whole payloads/bodies and credentials are censored
 * wherever a caller puts them, at the top level or one level down.
 */
export const REDACTED_PATHS: readonly string[] = [
  "amount",
  "balance",
  "money",
  "payload",
  "body",
  "data",
  "headers",
  "authorization",
  "cookie",
  "*.amount",
  "*.balance",
  "*.money",
  "*.payload",
  "*.body",
  "*.authorization",
  "*.cookie",
];

export interface PinoLoggerOptions {
  /** Present on every line: which process and which replica. */
  readonly base: { readonly process: string; readonly instanceId: string };
  readonly level?: string;
  /** Defaults to synchronous stdout: a line written before a crash is not lost in a buffer. */
  readonly destination?: DestinationStream;
}

/**
 * One JSON object per line: `level` (label), `time` (ISO), `process`, `instanceId`, `msg`, the
 * identifiers of the current log context (correlationId, messageId, transactionId, walletId,
 * providerId) and the caller's fields, which win over the context.
 */
export function createPino(options: PinoLoggerOptions): Pino {
  return pino(
    {
      level: options.level ?? "info",
      base: { process: options.base.process, instanceId: options.base.instanceId },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => ({ ...logContext.current() }),
      redact: { paths: [...REDACTED_PATHS], censor: REDACTED },
    },
    options.destination ?? pino.destination({ dest: 1, sync: true }),
  );
}

export class PinoLogger implements Logger {
  constructor(private readonly pino: Pino) {}

  static create(options: PinoLoggerOptions): PinoLogger {
    return new PinoLogger(createPino(options));
  }

  info(message: string, fields?: LogFields): void {
    this.pino.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.pino.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.pino.error(fields ?? {}, message);
  }
}
