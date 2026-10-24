import { describe, expect, test } from "bun:test";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs-client.factory.ts";

const base = {
  region: "us-east-1",
  wagerQueueName: "wager-transactions.fifo",
  wagerDlqName: "wager-transactions-dlq.fifo",
  eventsQueueName: "wallet-events.fifo",
} as const;

describe("createSqsClient", () => {
  test("never lets the QueueUrl host override the configured endpoint", async () => {
    const client = createSqsClient({ ...base, endpoint: "http://localstack:4566" });
    try {
      expect(client.config.useQueueUrlAsEndpoint).toBe(false);
      const endpoint = await client.config.endpoint?.();
      expect(`${endpoint?.protocol}//${endpoint?.hostname}:${endpoint?.port}`).toBe(
        "http://localstack:4566",
      );
    } finally {
      client.destroy();
    }
  });

  test("without SQS_ENDPOINT it targets real AWS, still ignoring the QueueUrl host", () => {
    const client = createSqsClient({ ...base, endpoint: undefined });
    try {
      expect(client.config.useQueueUrlAsEndpoint).toBe(false);
      expect(client.config.endpoint).toBeUndefined();
    } finally {
      client.destroy();
    }
  });
});
