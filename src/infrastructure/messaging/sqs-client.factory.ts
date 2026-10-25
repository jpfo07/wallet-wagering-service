import { SQSClient } from "@aws-sdk/client-sqs";
import type { SqsConfig } from "../config/env.ts";

/**
 * The endpoint always comes from configuration: LocalStack, MiniStack or real AWS
 * are swapped by env only. Queue URLs are obtained from GetQueueUrl, never built by hand.
 * Credentials come from the default AWS provider chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
 *
 * `useQueueUrlAsEndpoint: false`: by default the SDK may redirect a request to the host
 * inside `QueueUrl` (e.g. `localstack:4566` or `*.localstack.cloud`). We pin it off so every
 * request goes to the configured endpoint (or the regional AWS endpoint), regardless of the
 * host the emulator writes into queue URLs.
 *
 * `requestTimeoutMs` / `maxAttempts` bound how long one call can take (the outbox publisher holds
 * row locks while it waits for SQS).
 */
export function createSqsClient(
  config: SqsConfig,
  options: { readonly requestTimeoutMs?: number; readonly maxAttempts?: number } = {},
): SQSClient {
  return new SQSClient({
    region: config.region,
    useQueueUrlAsEndpoint: false,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestHandler: { requestTimeout: options.requestTimeoutMs } }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
}
