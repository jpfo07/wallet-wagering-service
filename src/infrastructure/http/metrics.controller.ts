import { Controller, Get, Header, Inject } from "@nestjs/common";
import { Public } from "../auth/public.decorator.ts";
import { PROCESS_TELEMETRY } from "../observability/observability.module.ts";
import type { ProcessTelemetry } from "../observability/process-telemetry.ts";

/** Prometheus exposition of this API replica. Open like health (no provider credentials). */
@Public()
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(PROCESS_TELEMETRY) private readonly telemetry: ProcessTelemetry) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  metrics(): Promise<string> {
    return this.telemetry.registry.metrics();
  }
}
