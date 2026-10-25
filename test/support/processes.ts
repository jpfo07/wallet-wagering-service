import type { Subprocess } from "bun";
import { waitFor } from "./polling.ts";

/** Printed by processes/consumer-crash-before-ack.ts once COMMIT is done and the ack is pending. */
export const CRASH_POINT_MARKER = "CRASH_POINT_BEFORE_ACK";

const ROOT = new URL("../../", import.meta.url).pathname;

export function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);
  if (port === undefined) throw new Error("could not allocate a port");
  return port;
}

export interface ChildProcess {
  readonly child: Subprocess<"ignore", "pipe", "pipe">;
  /** Everything written to stdout so far. */
  output(): string;
  waitForOutput(text: string, timeoutMs?: number): Promise<void>;
  /** Resolves with the exit code, or "timeout". */
  exited(timeoutMs: number): Promise<number | "timeout">;
  /** SIGKILL if still running (for `finally`). */
  kill(): void;
}

/** Runs a script of this repository as a separate Bun process and collects its stdout. */
export function spawnScript(script: string, env: Record<string, string>): ChildProcess {
  const child = Bun.spawn(["bun", "run", script], {
    cwd: ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) stdout += decoder.decode(chunk, { stream: true });
  })();
  return {
    child,
    output: () => stdout,
    waitForOutput: (text, timeoutMs = 20_000) =>
      waitFor(() => stdout.includes(text), {
        timeoutMs,
        intervalMs: 20,
        description: `"${text}" on the stdout of ${script}`,
      }).then(() => undefined),
    exited: (timeoutMs) =>
      Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => "timeout" as const)]),
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}
