import { Controller, Get, Inject, Res } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { Public } from "../auth/public.decorator.ts";
import { APP_CONFIG } from "../config/config.module.ts";
import type { AppConfig } from "../config/env.ts";
import { SQS_CLIENT } from "../messaging/messaging.module.ts";
import { checkReadiness } from "../observability/readiness.ts";
import { DatabaseProbe } from "../persistence/database-probe.ts";
import type { ReadinessReport } from "../observability/readiness.ts";
import { HttpDrain } from "./http-drain.ts";
import type { HttpResponse } from "./request-context.decorator.ts";

/** Open by design (section 2): orchestrator and proxy probes carry no provider credentials. */
@Public()
@Controller("health")
export class HealthController {
  constructor(
    private readonly database: DatabaseProbe,
    private readonly drain: HttpDrain,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: only says the process is responsive. Never touches dependencies. */
  @Get("live")
  live(): { status: "ok"; instanceId: string } {
    return { status: "ok", instanceId: this.config.instanceId };
  }

  /**
   * Readiness: PostgreSQL and SQS must be reachable. A 503 here is a probe answer (for the
   * orchestrator and the proxy), not a request error, so it keeps its own body with the checks.
   */
  @Get("ready")
  async ready(
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<
    { status: "ok" | "unavailable"; checks: ReadinessReport["checks"] } | { status: "draining" }
  > {
    if (this.drain.active) {
      response.status(503);
      return { status: "draining" };
    }
    const report = await checkReadiness({
      pingPostgres: () => this.database.ping(),
      sqs: this.sqs,
      queueName: this.config.sqs.wagerQueueName,
    });
    if (!report.ready) {
      response.status(503);
      return { status: "unavailable", checks: report.checks };
    }
    return { status: "ok", checks: report.checks };
  }
}
