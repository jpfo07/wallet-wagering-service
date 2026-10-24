import { runWorker } from "./run-worker.ts";

await runWorker("outbox-publisher");
