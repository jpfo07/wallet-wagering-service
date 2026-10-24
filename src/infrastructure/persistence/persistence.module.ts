import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { APP_CONFIG } from "../config/config.module.ts";
import type { AppConfig } from "../config/env.ts";
import { buildOrmOptions } from "./mikro-orm.config.ts";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildOrmOptions(config.database),
    }),
  ],
})
export class PersistenceModule {}
