import { AsyncLocalStorage } from "node:async_hooks";

/** Identifiers every log line of a request or message carries without each caller passing them. */
export interface LogContextFields {
  readonly correlationId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly transactionId?: string | undefined;
  readonly walletId?: string | undefined;
  readonly providerId?: string | undefined;
}

const storage = new AsyncLocalStorage<LogContextFields>();

/**
 * Logging context of the unit of work in progress (HTTP request, SQS message, worker candidate).
 * Opened by the entrypoint adapters; the application layer never sees it, and the logger merges it
 * into every line (explicit fields win). Diagnostics only: nothing reads it to decide anything.
 */
export const logContext = {
  run<T>(fields: LogContextFields, work: () => T): T {
    return storage.run({ ...storage.getStore(), ...withoutUndefined(fields) }, work);
  },

  current(): LogContextFields {
    return storage.getStore() ?? {};
  },
};

function withoutUndefined(fields: LogContextFields): LogContextFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
