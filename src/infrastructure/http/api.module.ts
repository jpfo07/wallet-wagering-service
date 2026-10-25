import { Module } from "@nestjs/common";
import { ApplicationModule } from "../application/application.module.ts";
import { ConfigModule } from "../config/config.module.ts";
import { MessagingModule } from "../messaging/messaging.module.ts";
import { PersistenceModule } from "../persistence/persistence.module.ts";
import { HealthController } from "./health.controller.ts";

@Module({
  imports: [ConfigModule, PersistenceModule, MessagingModule, ApplicationModule],
  controllers: [HealthController],
})
export class ApiModule {}
