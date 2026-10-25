import { runWorker } from "./run-worker.ts";

await runWorker("pending-reference-worker", async (app, config) => {
  const { startPendingReferenceWorkerInNest } =
    await import("../infrastructure/workers/workers.nest.ts");
  return startPendingReferenceWorkerInNest(app, config);
});
