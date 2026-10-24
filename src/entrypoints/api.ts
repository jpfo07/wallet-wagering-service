import "reflect-metadata";
import { loadConfig } from "../infrastructure/config/env.ts";
import { createApiApp } from "../infrastructure/http/create-api-app.ts";
import { installGracefulShutdown } from "./graceful-shutdown.ts";

const config = loadConfig();
const log = (message: string): void => {
  console.log(
    JSON.stringify({ level: "info", process: "api", instanceId: config.instanceId, message }),
  );
};

const app = await createApiApp(config.instanceId);
installGracefulShutdown(app, { timeoutMs: 10_000, log });
await app.listen(config.httpPort, "0.0.0.0");
log(`listening on port ${config.httpPort}`);
