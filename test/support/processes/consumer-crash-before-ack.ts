/**
 * Test-only entrypoint: the real consumer (same composition, same use case, real PostgreSQL and
 * LocalStack), except that its SQS client never completes DeleteMessage. It announces that point on
 * stdout, after the use case returned (i.e. after COMMIT), and hangs there, so the test can SIGKILL
 * it exactly between the commit and the ack. Nothing in production code knows about this.
 */
import "reflect-metadata";
import { DeleteMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { buildApplication } from "../../../src/infrastructure/application/composition.ts";
import { loadConfig } from "../../../src/infrastructure/config/env.ts";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs-client.factory.ts";
import { startWagerConsumer } from "../../../src/infrastructure/messaging/start-wager-consumer.ts";
import { InMemoryConsumerMetrics } from "../in-memory-telemetry.ts";
import { buildOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm.config.ts";
import { CRASH_POINT_MARKER } from "../processes.ts";

const config = loadConfig();
const orm = await MikroORM.init(buildOrmOptions(config.database));
const application = buildApplication(orm, config);
const real = createSqsClient(config.sqs);

const sqs = new Proxy(real, {
  get(target, property, receiver) {
    if (property !== "send") return Reflect.get(target, property, receiver) as unknown;
    return (
      command: Parameters<SQSClient["send"]>[0],
      options?: Parameters<SQSClient["send"]>[1],
    ) => {
      if (command instanceof DeleteMessageCommand) {
        console.log(JSON.stringify({ marker: CRASH_POINT_MARKER }));
        return new Promise(() => undefined);
      }
      return target.send(command, options);
    };
  },
});

const { clock, random, logger } = application.dependencies;
await startWagerConsumer({
  sqs,
  sqsConfig: config.sqs,
  consumer: config.sqsConsumer,
  database: config.database,
  transientRetry: config.transientRetry,
  processWager: application.processWagerTransaction,
  pingDatabase: () => orm.em.getConnection().execute("select 1"),
  clock,
  random,
  logger,
  metrics: new InMemoryConsumerMetrics(),
});
