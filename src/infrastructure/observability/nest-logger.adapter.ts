import type { LoggerService } from "@nestjs/common";
import type { Logger } from "../../application/ports/telemetry.ts";

export type NestLogLevel = "log" | "warn" | "error";

/**
 * Nest's own messages (boot, route mapping, framework errors) through the process logger, so every
 * line of a process is the same JSON shape. Debug and verbose are dropped, and so is any level not
 * enabled (workers keep only warn and error).
 */
export class NestLoggerAdapter implements LoggerService {
  private readonly levels: ReadonlySet<NestLogLevel>;

  constructor(
    private readonly logger: Logger,
    levels: readonly NestLogLevel[] = ["log", "warn", "error"],
  ) {
    this.levels = new Set(levels);
  }

  log(message: unknown, ...params: unknown[]): void {
    if (!this.levels.has("log")) return;
    this.logger.info(text(message), { context: contextOf(params) });
  }

  warn(message: unknown, ...params: unknown[]): void {
    if (!this.levels.has("warn")) return;
    this.logger.warn(text(message), { context: contextOf(params) });
  }

  error(message: unknown, ...params: unknown[]): void {
    if (!this.levels.has("error")) return;
    const context = contextOf(params);
    const stack = params.length > 1 && typeof params[0] === "string" ? params[0] : undefined;
    this.logger.error(text(message), {
      context,
      stack: message instanceof Error ? message.stack : stack,
    });
  }

  debug(): void {}

  verbose(): void {}
}

function text(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  return JSON.stringify(message);
}

/** Nest passes the context (class name) as the last parameter. */
function contextOf(params: readonly unknown[]): string | undefined {
  const last = params.at(-1);
  return typeof last === "string" ? last : undefined;
}
