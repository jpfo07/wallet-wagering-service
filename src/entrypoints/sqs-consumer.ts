import { runWorker } from "./run-worker.ts";

await runWorker("sqs-consumer", async (app, config) => {
  const { startWagerConsumerInNest } =
    await import("../infrastructure/messaging/wager-consumer.nest.ts");
  return startWagerConsumerInNest(app, config);
});
