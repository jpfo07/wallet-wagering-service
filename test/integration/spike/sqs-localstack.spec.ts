import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import { createIsolatedQueues, testSqsClient } from "../../support/queues.ts";
import type { IsolatedQueues } from "../../support/queues.ts";
import { testInfra } from "../../support/test-env.ts";
import { waitFor } from "../../support/polling.ts";

const ACCOUNT = "000000000000";

describe("spike C — SQS on LocalStack 4.14.0", () => {
  let sqs: SQSClient;
  let queues: IsolatedQueues;
  let redriveQueues: IsolatedQueues;

  beforeAll(async () => {
    sqs = testSqsClient();
    queues = await createIsolatedQueues("spike-sqs");
    redriveQueues = await createIsolatedQueues("spike-redrive", {
      maxReceiveCount: 3,
      visibilityTimeoutSeconds: 30,
    });
  });

  afterAll(async () => {
    await queues.delete();
    await redriveQueues.delete();
    sqs.destroy();
  });

  async function receive(queueUrl: string, waitSeconds = 1): Promise<Message[]> {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    return Messages ?? [];
  }

  async function receiveOne(queueUrl: string, description: string): Promise<Message> {
    return waitFor(async () => (await receive(queueUrl))[0], { description });
  }

  async function attributes(queueUrl: string): Promise<Record<string, string>> {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["All"] }),
    );
    return Attributes ?? {};
  }

  const urlOf = (name: string): string => `${testInfra.sqsQueueUrlBase}/${ACCOUNT}/${name}`;

  test("C10: queue URLs are http://localstack:4566/<account>/<queue> (no localstack.cloud DNS)", async () => {
    for (const name of [
      "wager-transactions.fifo",
      "wager-transactions-dlq.fifo",
      "wallet-events.fifo",
    ]) {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      expect(QueueUrl).toBe(urlOf(name));
      expect(QueueUrl).not.toContain("localstack.cloud");
    }
    expect(queues.wagerQueueUrl).toBe(urlOf(queues.wagerQueueName));
  });

  test("C10b: the SDK routes through the configured endpoint, not the host inside the QueueUrl", async () => {
    // From the host machine "localstack" does not resolve; this only works because the
    // client sends every request to SQS_ENDPOINT. Inside the compose network both coincide.
    const { MessageId } = await sqs.send(
      new SendMessageCommand({
        QueueUrl: urlOf(queues.eventsQueueName),
        MessageBody: "routing",
        MessageGroupId: "routing",
        MessageDeduplicationId: `routing-${Bun.randomUUIDv7()}`,
      }),
    );
    expect(MessageId).toBeString();
  });

  test("C11: init script creates FIFO queues with explicit dedup and a redrive policy to the DLQ", async () => {
    const url = urlOf;
    const main = await attributes(url("wager-transactions.fifo"));
    expect(main["FifoQueue"]).toBe("true");
    expect(main["ContentBasedDeduplication"]).toBe("false");
    expect(main["VisibilityTimeout"]).toBe("60");
    const redrive = JSON.parse(main["RedrivePolicy"] ?? "{}") as Record<string, unknown>;
    expect(String(redrive["deadLetterTargetArn"])).toEndWith(":wager-transactions-dlq.fifo");
    expect(String(redrive["maxReceiveCount"])).toBe("5");

    for (const name of ["wager-transactions-dlq.fifo", "wallet-events.fifo"]) {
      const attrs = await attributes(url(name));
      expect(attrs["FifoQueue"]).toBe("true");
      expect(attrs["ContentBasedDeduplication"]).toBe("false");
    }
  });

  test("C12: MessageDeduplicationId drops a duplicate inside the dedup window", async () => {
    const send = (body: string, dedupId: string) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.wagerQueueUrl,
          MessageBody: body,
          MessageGroupId: "wallet-1",
          MessageDeduplicationId: dedupId,
        }),
      );
    const first = await send("first", "dedup-x");
    const duplicate = await send("first-again", "dedup-x");
    await send("second", "dedup-y");
    // A deduplicated send is acknowledged with the original MessageId.
    expect(duplicate.MessageId).toBe(first.MessageId);

    // Same group => strict order. If the duplicate had been accepted it would come before "second".
    const bodies: string[] = [];
    await waitFor(
      async () => {
        for (const message of await receive(queues.wagerQueueUrl)) {
          bodies.push(message.Body ?? "");
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: queues.wagerQueueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
        return bodies.includes("second");
      },
      { description: "second message to be delivered" },
    );
    expect(bodies).toEqual(["first", "second"]);
  });

  test("C13: ChangeMessageVisibility hides and releases an in-flight message", async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.wagerQueueUrl,
        MessageBody: "visibility",
        MessageGroupId: "wallet-2",
        MessageDeduplicationId: `vis-${Bun.randomUUIDv7()}`,
      }),
    );
    const firstDelivery = await receiveOne(queues.wagerQueueUrl, "first delivery");
    expect(firstDelivery.Attributes?.ApproximateReceiveCount).toBe("1");

    // Still invisible (30s default): a new poll within a 1s window gets nothing.
    expect(await receive(queues.wagerQueueUrl, 1)).toHaveLength(0);

    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queues.wagerQueueUrl,
        ReceiptHandle: firstDelivery.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    const redelivery = await receiveOne(queues.wagerQueueUrl, "redelivery after visibility 0");
    expect(redelivery.MessageId).toBe(firstDelivery.MessageId);
    expect(redelivery.Attributes?.ApproximateReceiveCount).toBe("2");
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queues.wagerQueueUrl,
        ReceiptHandle: redelivery.ReceiptHandle,
      }),
    );
  });

  test("C14: after maxReceiveCount receives without ack the message lands in the DLQ", async () => {
    const { MessageId } = await sqs.send(
      new SendMessageCommand({
        QueueUrl: redriveQueues.wagerQueueUrl,
        MessageBody: "poison",
        MessageGroupId: "wallet-3",
        MessageDeduplicationId: `poison-${Bun.randomUUIDv7()}`,
      }),
    );
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const message = await receiveOne(redriveQueues.wagerQueueUrl, `delivery #${attempt}`);
      expect(message.MessageId).toBe(MessageId);
      expect(message.Attributes?.ApproximateReceiveCount).toBe(String(attempt));
      // Simulates a failed processing attempt: give the message back immediately.
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: redriveQueues.wagerQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }

    // The next receive exceeds maxReceiveCount: SQS moves the message instead of delivering it.
    expect(await receive(redriveQueues.wagerQueueUrl, 1)).toHaveLength(0);
    const dead = await receiveOne(redriveQueues.dlqUrl, "message in the DLQ");
    expect(dead.Body).toBe("poison");
    expect(dead.MessageId).toBe(MessageId);
  });
});
