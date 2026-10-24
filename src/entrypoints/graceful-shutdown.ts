export interface GracefulShutdown {
  /** Plugs in what closing means once the process has booted (stop taking work, app.close()). */
  register(close: () => Promise<void>): void;
}

/**
 * Own SIGTERM/SIGINT handling instead of Nest's enableShutdownHooks(), which re-raises
 * the signal after closing (exit by signal).
 *
 * Must be called before any heavy module is loaded: as PID 1 in a container, a signal with
 * no handler installed is ignored by the kernel, so a SIGTERM that arrives during boot would
 * be lost and Docker would SIGKILL the process at the end of the grace period (exit 137).
 * Entrypoints therefore import only this module and the config statically, and load Nest
 * and the rest with `await import()`. The compose also runs tini (`init: true`) as a safety
 * net for the few milliseconds before this handler exists: the process then dies by the
 * signal (exit 143) instead of hanging.
 *
 * A signal before `register` exits 0 at once: nothing is being processed yet. After it, the
 * registered close runs and the process exits 0, or 1 if closing fails or exceeds the deadline.
 */
export function installGracefulShutdown(options: {
  readonly timeoutMs: number;
  readonly log: (message: string) => void;
}): GracefulShutdown {
  let close: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (close === undefined) {
      options.log(`received ${signal} during startup, exiting`);
      process.exit(0);
    }
    options.log(`received ${signal}, shutting down`);
    const deadline = setTimeout(() => {
      options.log("shutdown deadline exceeded, forcing exit");
      process.exit(1);
    }, options.timeoutMs);
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
  return {
    register: (fn) => {
      close = fn;
    },
  };
}
