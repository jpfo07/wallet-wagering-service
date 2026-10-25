import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { ApplicationModule } from "./application/application.module.ts";
import { ConfigModule } from "./config/config.module.ts";
import { MessagingModule } from "./messaging/messaging.module.ts";
import { ObservabilityModule } from "./observability/observability.module.ts";
import type { ProcessName } from "./observability/process-telemetry.ts";
import { PersistenceModule } from "./persistence/persistence.module.ts";

/** Application context shared by the worker processes (no HTTP layer). */
@Module({})
export class WorkerModule {
  static forProcess(process: Exclude<ProcessName, "api">): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule,
        ObservabilityModule.forProcess(process),
        PersistenceModule,
        MessagingModule,
        ApplicationModule,
      ],
    };
  }
}
