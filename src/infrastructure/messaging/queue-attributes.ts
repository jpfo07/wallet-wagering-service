import { GetQueueAttributesCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { ConfigError } from "../config/env.ts";

export interface WagerQueueTopology {
  readonly queueUrl: string;
  readonly dlqUrl: string;
  readonly visibilityTimeoutSeconds: number;
  readonly maxReceiveCount: number;
}

async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (QueueUrl === undefined) throw new ConfigError(`Fila ${name} não encontrada`);
  return QueueUrl;
}

function parseRedrive(raw: string | undefined, queueName: string): { arn: string; max: number } {
  if (raw === undefined) {
    throw new ConfigError(`Fila ${queueName} sem RedrivePolicy: sem limite de tentativas nem DLQ`);
  }
  const policy: unknown = JSON.parse(raw);
  if (typeof policy !== "object" || policy === null) {
    throw new ConfigError(`RedrivePolicy inválida em ${queueName}`);
  }
  const { deadLetterTargetArn, maxReceiveCount } = policy as Record<string, unknown>;
  const max = Number(maxReceiveCount);
  if (typeof deadLetterTargetArn !== "string" || !Number.isInteger(max) || max < 1) {
    throw new ConfigError(`RedrivePolicy inválida em ${queueName}`);
  }
  return { arn: deadLetterTargetArn, max };
}

/**
 * Reads what the consumer depends on from the queues themselves (never assumed from env): the
 * VisibilityTimeout, and a redrive policy whose target is the configured DLQ.
 */
export async function inspectWagerQueue(
  sqs: SQSClient,
  names: { readonly queueName: string; readonly dlqName: string },
): Promise<WagerQueueTopology> {
  const [url, dlqUrl] = await Promise.all([
    queueUrl(sqs, names.queueName),
    queueUrl(sqs, names.dlqName),
  ]);
  const [queue, dlq] = await Promise.all([
    sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ["VisibilityTimeout", "RedrivePolicy"],
      }),
    ),
    sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] })),
  ]);
  const redrive = parseRedrive(queue.Attributes?.RedrivePolicy, names.queueName);
  if (redrive.arn !== dlq.Attributes?.QueueArn) {
    throw new ConfigError(
      `A RedrivePolicy de ${names.queueName} aponta para ${redrive.arn}, não para ${names.dlqName}`,
    );
  }
  const visibility = Number(queue.Attributes?.VisibilityTimeout);
  if (!Number.isInteger(visibility)) {
    throw new ConfigError(`VisibilityTimeout ausente em ${names.queueName}`);
  }
  return {
    queueUrl: url,
    dlqUrl,
    visibilityTimeoutSeconds: visibility,
    maxReceiveCount: redrive.max,
  };
}
