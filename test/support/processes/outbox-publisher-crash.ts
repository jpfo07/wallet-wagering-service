/**
 * Test-only entrypoint: the real outbox publisher (same composition, real PostgreSQL and
 * LocalStack), except that its SQS client stops at a crash point, announces it on stdout and hangs
 * there, with the batch's SQL transaction still open, so the test can SIGKILL it exactly there:
 *
 * - OUTBOX_CRASH_MODE=before-send: the events were committed by the use case; the publisher claimed
 *   them and dies before SQS receives anything.
 * - OUTBOX_CRASH_MODE=after-send: SQS accepted the batch; the publisher dies before marking the
 *   events published.
 *
 * Nothing in production code knows about this.
 */
import "reflect-metadata";
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { buildApplication } from "../../../src/infrastructure/application/composition.ts";
import { loadConfig } from "../../../src/infrastructure/config/env.ts";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs-client.factory.ts";
import { buildOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm.config.ts";
import { startOutboxPublisher } from "../../../src/infrastructure/workers/start-outbox-publisher.ts";
import { OUTBOX_CRASH_MARKER } from "../processes.ts";

const mode = process.env["OUTBOX_CRASH_MODE"];
if (mode !== "before-send" && mode !== "after-send") {
  throw new Error(`OUTBOX_CRASH_MODE must be before-send or after-send, got ${String(mode)}`);
}

const config = loadConfig();
const orm = await MikroORM.init(buildOrmOptions(config.database));
const application = buildApplication(orm, config);
const real = createSqsClient(config.sqs);

const hang = (): Promise<never> => {
  console.log(JSON.stringify({ marker: OUTBOX_CRASH_MARKER, mode }));
  return new Promise<never>(() => undefined);
};

const sqs = new Proxy(real, {
  get(target, property, receiver) {
    if (property !== "send") return Reflect.get(target, property, receiver) as unknown;
    return async (
      command: Parameters<SQSClient["send"]>[0],
      options?: Parameters<SQSClient["send"]>[1],
    ) => {
      if (!(command instanceof SendMessageBatchCommand)) return target.send(command, options);
      if (mode === "before-send") return hang();
      await target.send(command, options);
      return hang();
    };
  },
});

await startOutboxPublisher({
  sqs,
  eventsQueueName: config.sqs.eventsQueueName,
  config: config.outboxPublisher,
  database: config.database,
  application,
});
