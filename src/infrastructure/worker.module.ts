import { Module } from "@nestjs/common";
import { ApplicationModule } from "./application/application.module.ts";
import { ConfigModule } from "./config/config.module.ts";
import { MessagingModule } from "./messaging/messaging.module.ts";
import { PersistenceModule } from "./persistence/persistence.module.ts";

/** Application context shared by the worker processes (no HTTP layer). */
@Module({
  imports: [ConfigModule, PersistenceModule, MessagingModule, ApplicationModule],
})
export class WorkerModule {}
