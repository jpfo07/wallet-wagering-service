import { Inject, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { APP_CONFIG } from "../config/config.module.ts";
import type { AppConfig } from "../config/env.ts";
import { createSqsClient } from "./sqs-client.factory.ts";

export const SQS_CLIENT = Symbol("SQS_CLIENT");

@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config.sqs),
    },
  ],
  exports: [SQS_CLIENT],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
