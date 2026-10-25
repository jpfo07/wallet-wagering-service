import { loadConfig } from "../infrastructure/config/env.ts";
import { bootLog } from "../infrastructure/observability/boot-log.ts";
import { installGracefulShutdown } from "./graceful-shutdown.ts";

const config = loadConfig();
const log = bootLog({ process: "api", instanceId: config.instanceId });

// Signal handler first, heavy modules after it (see graceful-shutdown.ts). The deadline covers the
// drain window plus closing.
const shutdown = installGracefulShutdown({
  timeoutMs: 10_000 + config.httpShutdownDrainMs,
  log,
});
log("starting");
await import("reflect-metadata");
const { createApiApp } = await import("../infrastructure/http/create-api-app.ts");
const { HttpDrain } = await import("../infrastructure/http/http-drain.ts");

const app = await createApiApp();
shutdown.register(async () => {
  // Keep serving (Connection: close, readiness 503) until the proxy has no socket left to us.
  if (config.httpShutdownDrainMs > 0) {
    app.get(HttpDrain).begin();
    log(`draining for ${config.httpShutdownDrainMs}ms`);
    await Bun.sleep(config.httpShutdownDrainMs);
  }
  await app.close();
});
await app.listen(config.httpPort, "0.0.0.0");
log(`listening on port ${config.httpPort}`);
