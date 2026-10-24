import type { ReadinessReport } from "./readiness.ts";

export interface WorkerHealthServer {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * Tiny internal HTTP server for workers, which have no Nest HTTP layer:
 * `/health/live` (process responsive) and `/health/ready` (dependencies reachable).
 * `/metrics` joins in Phase 7.
 */
export function startWorkerHealthServer(options: {
  readonly port: number;
  readonly processName: string;
  readonly instanceId: string;
  readonly readiness: () => Promise<ReadinessReport>;
}): WorkerHealthServer {
  const server = Bun.serve({
    port: options.port,
    hostname: "0.0.0.0",
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/health/live") {
        return Response.json({
          status: "ok",
          process: options.processName,
          instanceId: options.instanceId,
        });
      }
      if (pathname === "/health/ready") {
        const report = await options.readiness();
        return Response.json(
          { status: report.ready ? "ok" : "unavailable", checks: report.checks },
          { status: report.ready ? 200 : 503 },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("worker health server has no port");
  return { port, stop: () => server.stop(true) };
}
