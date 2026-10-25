import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.factory.ts";
import { testSqsConfig } from "./test-env.ts";

export interface IsolatedQueues {
  readonly prefix: string;
  readonly wagerQueueName: string;
  readonly wagerQueueUrl: string;
  readonly dlqName: string;
  readonly dlqUrl: string;
  readonly eventsQueueName: string;
  readonly eventsQueueUrl: string;
  delete(): Promise<void>;
}

export interface IsolatedQueuesOptions {
  readonly maxReceiveCount?: number;
  readonly visibilityTimeoutSeconds?: number;
}

const FIFO = { FifoQueue: "true", ContentBasedDeduplication: "false" } as const;

export function testSqsClient(): SQSClient {
  return createSqsClient(testSqsConfig());
}

async function createQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
  );
  if (QueueUrl === undefined) throw new Error(`CreateQueue returned no URL for ${name}`);
  return QueueUrl;
}

/**
 * Creates the same queue topology as the LocalStack init script, under a unique prefix,
 * so suites never share messages. PurgeQueue is avoided (60s window on AWS).
 */
export async function createIsolatedQueues(
  suite: string,
  { maxReceiveCount = 5, visibilityTimeoutSeconds = 60 }: IsolatedQueuesOptions = {},
): Promise<IsolatedQueues> {
  const slug = suite
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 20);
  const prefix = `${slug}-${Bun.randomUUIDv7().replaceAll("-", "").slice(-10)}`;
  const sqs = testSqsClient();
  try {
    const dlqName = `${prefix}-wager-transactions-dlq.fifo`;
    const dlqUrl = await createQueue(sqs, dlqName, { ...FIFO });
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
    );
    const dlqArn = Attributes?.QueueArn;
    if (dlqArn === undefined) throw new Error(`No QueueArn for ${dlqName}`);

    const wagerQueueName = `${prefix}-wager-transactions.fifo`;
    const wagerQueueUrl = await createQueue(sqs, wagerQueueName, {
      ...FIFO,
      VisibilityTimeout: String(visibilityTimeoutSeconds),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: String(maxReceiveCount),
      }),
    });

    const eventsQueueName = `${prefix}-wallet-events.fifo`;
    const eventsQueueUrl = await createQueue(sqs, eventsQueueName, { ...FIFO });

    return {
      prefix,
      wagerQueueName,
      wagerQueueUrl,
      dlqName,
      dlqUrl,
      eventsQueueName,
      eventsQueueUrl,
      delete: async () => {
        const client = testSqsClient();
        try {
          for (const url of [wagerQueueUrl, dlqUrl, eventsQueueUrl]) {
            await client.send(new DeleteQueueCommand({ QueueUrl: url }));
          }
        } finally {
          client.destroy();
        }
      },
    };
  } finally {
    sqs.destroy();
  }
}
