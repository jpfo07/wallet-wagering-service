import { runWorker } from "./run-worker.ts";

await runWorker("outbox-publisher", async (app, config) => {
  const { startOutboxPublisherInNest } = await import("../infrastructure/workers/workers.nest.ts");
  return startOutboxPublisherInNest(app, config);
});
