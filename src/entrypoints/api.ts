import { loadConfig } from "../infrastructure/config/env.ts";
import { bootLog } from "../infrastructure/observability/boot-log.ts";
import { installGracefulShutdown } from "./graceful-shutdown.ts";

const config = loadConfig();
const log = bootLog({ process: "api", instanceId: config.instanceId });

// Signal handler first, heavy modules after it (see graceful-shutdown.ts).
const shutdown = installGracefulShutdown({ timeoutMs: 10_000, log });
log("starting");
await import("reflect-metadata");
const { createApiApp } = await import("../infrastructure/http/create-api-app.ts");

const app = await createApiApp();
shutdown.register(() => app.close());
await app.listen(config.httpPort, "0.0.0.0");
log(`listening on port ${config.httpPort}`);
