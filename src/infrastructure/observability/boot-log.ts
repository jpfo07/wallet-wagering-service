/**
 * Log of the entrypoints before (and around) the Nest boot, when pino is not loaded yet: the
 * signal handler must exist before any heavy module (see graceful-shutdown.ts). Same line shape
 * as the PinoLogger, so every line of a process parses the same way.
 */
export function bootLog(base: {
  readonly process: string;
  readonly instanceId: string;
}): (message: string) => void {
  return (message) => {
    const line = JSON.stringify({
      level: "info",
      time: new Date().toISOString(),
      process: base.process,
      instanceId: base.instanceId,
      msg: message,
    });
    process.stdout.write(`${line}\n`);
  };
}
