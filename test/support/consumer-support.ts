import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import type { LogFields, Logger } from "../../src/application/ports/telemetry.ts";
import type { WagerTransactionCommand } from "../../src/application/wager/process-wager-transaction.ts";
import type { DatabaseConfig, SqsConsumerConfig } from "../../src/infrastructure/config/env.ts";
import { startWagerConsumer } from "../../src/infrastructure/messaging/start-wager-consumer.ts";
import type { RunningWagerConsumer } from "../../src/infrastructure/messaging/start-wager-consumer.ts";
import { WAGER_TRANSACTION_REQUESTED } from "../../src/infrastructure/messaging/wager-message-envelope.ts";
import { InMemoryConsumerMetrics } from "../../src/infrastructure/observability/telemetry-adapters.ts";
import { MathRandomSource, SystemClock } from "../../src/infrastructure/system/system-adapters.ts";
import type { AppHandle } from "./application-suite.ts";
import type { IsolatedQueues } from "./queues.ts";
import { TEST_SQS_CONSUMER, TEST_TRANSIENT_RETRY, testSqsConfig } from "./test-env.ts";

export interface LogEntry {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields;
}

/** Keeps every log line, so tests can wait for "acknowledged", "retried"… and read the fields. */
export class CapturingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: "info", message, fields });
  }

  warn(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: "warn", message, fields });
  }

  error(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: "error", message, fields });
  }

  find(message: string, predicate: (fields: LogFields) => boolean = () => true): LogEntry[] {
    return this.entries.filter((entry) => entry.message === message && predicate(entry.fields));
  }
}

export interface TestConsumer extends RunningWagerConsumer {
  readonly logger: CapturingLogger;
  readonly metrics: InMemoryConsumerMetrics;
}

/** The real consumer, in this process, on isolated queues and the given application. */
export async function startTestConsumer(options: {
  readonly sqs: SQSClient;
  readonly queues: IsolatedQueues;
  readonly handle: AppHandle;
  readonly database: DatabaseConfig;
  readonly consumer?: Partial<SqsConsumerConfig>;
}): Promise<TestConsumer> {
  const logger = new CapturingLogger();
  const metrics = new InMemoryConsumerMetrics();
  const running = await startWagerConsumer({
    sqs: options.sqs,
    sqsConfig: testSqsConfig({
      wagerQueueName: options.queues.wagerQueueName,
      wagerDlqName: options.queues.dlqName,
      eventsQueueName: options.queues.eventsQueueName,
    }),
    consumer: { ...TEST_SQS_CONSUMER, ...options.consumer },
    database: options.database,
    transientRetry: TEST_TRANSIENT_RETRY,
    processWager: options.handle.app.processWagerTransaction,
    pingDatabase: () => options.handle.orm.em.getConnection().execute("select 1"),
    clock: new SystemClock(),
    random: new MathRandomSource(),
    logger,
    metrics,
  });
  return { ...running, logger, metrics };
}

/** The message of the challenge (section 10) carrying the command. */
export function wagerEnvelope(
  command: WagerTransactionCommand,
  messageId = `msg-${Bun.randomUUIDv7()}`,
): { readonly messageId: string; readonly body: string } {
  return {
    messageId,
    body: JSON.stringify({
      messageId,
      type: WAGER_TRANSACTION_REQUESTED,
      occurredAt: new Date().toISOString(),
      data: command,
    }),
  };
}

/**
 * Sends a body to the FIFO queue. Every send gets its own deduplication id unless given, so sending
 * the same envelope twice simulates a producer (or SQS) redelivery that the inbox must absorb.
 */
export async function sendRaw(
  sqs: SQSClient,
  queueUrl: string,
  body: string,
  groupId: string,
  options: { readonly deduplicationId?: string; readonly correlationId?: string } = {},
): Promise<string> {
  const { MessageId } = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: options.deduplicationId ?? Bun.randomUUIDv7(),
      ...(options.correlationId === undefined
        ? {}
        : {
            MessageAttributes: {
              correlationId: { DataType: "String", StringValue: options.correlationId },
            },
          }),
    }),
  );
  if (MessageId === undefined) throw new Error("SendMessage returned no MessageId");
  return MessageId;
}

export async function sendCommand(
  sqs: SQSClient,
  queueUrl: string,
  command: WagerTransactionCommand,
  messageId?: string,
): Promise<{ readonly messageId: string; readonly sqsMessageId: string }> {
  const envelope = wagerEnvelope(command, messageId);
  const sqsMessageId = await sendRaw(sqs, queueUrl, envelope.body, command.walletId);
  return { messageId: envelope.messageId, sqsMessageId };
}

export interface QueueCounts {
  readonly visible: number;
  readonly inFlight: number;
}

export async function queueCounts(sqs: SQSClient, queueUrl: string): Promise<QueueCounts> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? "0"),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0"),
  };
}

export async function isQueueEmpty(sqs: SQSClient, queueUrl: string): Promise<boolean> {
  const counts = await queueCounts(sqs, queueUrl);
  return counts.visible === 0 && counts.inFlight === 0;
}

/** Reads (without deleting) up to 10 messages of the DLQ, with their attributes. */
export async function peekDlq(sqs: SQSClient, dlqUrl: string): Promise<Message[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 0,
      MessageAttributeNames: ["All"],
      MessageSystemAttributeNames: ["All"],
    }),
  );
  return Messages ?? [];
}

export function attribute(message: Message, name: string): string | undefined {
  return message.MessageAttributes?.[name]?.StringValue;
}
