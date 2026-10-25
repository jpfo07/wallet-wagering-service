import { loadConfig } from "../infrastructure/config/env.ts";
import { installGracefulShutdown } from "./graceful-shutdown.ts";

const config = loadConfig();
const log = (message: string): void => {
  console.log(
    JSON.stringify({ level: "info", process: "api", instanceId: config.instanceId, message }),
  );
};

// Signal handler first, heavy modules after it (see graceful-shutdown.ts).
const shutdown = installGracefulShutdown({ timeoutMs: 10_000, log });
log("starting");
await import("reflect-metadata");
const { createApiApp } = await import("../infrastructure/http/create-api-app.ts");

const app = await createApiApp();
shutdown.register(() => app.close());
await app.listen(config.httpPort, "0.0.0.0");
log(`listening on port ${config.httpPort}`);
