import type { INestApplicationContext } from "@nestjs/common";

/**
 * Own SIGTERM/SIGINT handling instead of Nest's enableShutdownHooks(), which re-raises
 * the signal after closing (exit by signal). Here `beforeClose` runs first (e.g. stop
 * taking new work), then app.close() runs the Nest shutdown hooks (pool, SQS client) and
 * the process exits 0, or 1 if closing fails or exceeds the deadline.
 */
export function installGracefulShutdown(
  app: INestApplicationContext,
  options: {
    readonly timeoutMs: number;
    readonly log: (message: string) => void;
    readonly beforeClose?: () => Promise<void>;
  },
): void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.log(`received ${signal}, shutting down`);
    const deadline = setTimeout(() => {
      options.log("shutdown deadline exceeded, forcing exit");
      process.exit(1);
    }, options.timeoutMs);
    const close = async (): Promise<void> => {
      await options.beforeClose?.();
      await app.close();
    };
    close().then(
      () => {
        clearTimeout(deadline);
        options.log("shutdown complete");
        process.exit(0);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        options.log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
