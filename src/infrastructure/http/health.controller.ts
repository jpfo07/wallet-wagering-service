import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { APP_CONFIG } from "../config/config.module.ts";
import type { AppConfig } from "../config/env.ts";
import { SQS_CLIENT } from "../messaging/messaging.module.ts";

type CheckResult = "up" | "down";

@Controller("health")
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: only says the process is responsive. Never touches dependencies. */
  @Get("live")
  live(): { status: "ok"; instanceId: string } {
    return { status: "ok", instanceId: this.config.instanceId };
  }

  /** Readiness: PostgreSQL and SQS must be reachable. */
  @Get("ready")
  async ready(): Promise<{ status: "ok"; checks: Record<string, CheckResult> }> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const checks = { postgres, sqs };
    if (postgres === "down" || sqs === "down") {
      throw new ServiceUnavailableException({ status: "unavailable", checks });
    }
    return { status: "ok", checks };
  }

  private async checkPostgres(): Promise<CheckResult> {
    try {
      await this.orm.em.getConnection().execute("select 1");
      return "up";
    } catch {
      return "down";
    }
  }

  private async checkSqs(): Promise<CheckResult> {
    try {
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueueName }));
      return "up";
    } catch {
      return "down";
    }
  }
}
