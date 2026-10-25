import { Module } from "@nestjs/common";
import { ApplicationModule } from "../application/application.module.ts";
import { AuthModule } from "../auth/auth.module.ts";
import { ConfigModule } from "../config/config.module.ts";
import { MessagingModule } from "../messaging/messaging.module.ts";
import { ObservabilityModule } from "../observability/observability.module.ts";
import { PersistenceModule } from "../persistence/persistence.module.ts";
import { HealthController } from "./health.controller.ts";
import { MetricsController } from "./metrics.controller.ts";
import { WageringController } from "./wagering.controller.ts";
import { WalletsController } from "./wallets.controller.ts";

@Module({
  imports: [
    ConfigModule,
    ObservabilityModule.forProcess("api"),
    PersistenceModule,
    MessagingModule,
    ApplicationModule,
    AuthModule,
  ],
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
})
export class ApiModule {}
