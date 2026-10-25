import { Global, Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { APP_CONFIG } from "../config/config.module.ts";
import type { AppConfig } from "../config/env.ts";
import { createProcessTelemetry } from "./process-telemetry.ts";
import type { ProcessName } from "./process-telemetry.ts";

export const PROCESS_TELEMETRY = Symbol("PROCESS_TELEMETRY");

/** One logger and one metrics registry per process, named after it (`process` on every line). */
@Global()
@Module({})
export class ObservabilityModule {
  static forProcess(process: ProcessName): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        {
          provide: PROCESS_TELEMETRY,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) =>
            createProcessTelemetry({ process, instanceId: config.instanceId }),
        },
      ],
      exports: [PROCESS_TELEMETRY],
    };
  }
}
