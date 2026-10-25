import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import type { MikroORM as PostgreSqlMikroORM } from "@mikro-orm/postgresql";
import {
  GetLedgerPage,
  GetTransaction,
  GetTransactionByExternalId,
  GetWallet,
} from "../../application/queries/queries.ts";
import { ProcessWagerTransaction } from "../../application/wager/process-wager-transaction.ts";
import { CreateWallet } from "../../application/wallet/create-wallet.ts";
import { ReconcileWallet } from "../../application/wallet/reconcile-wallet.ts";
import { APP_CONFIG } from "../config/config.module.ts";
import type { AppConfig } from "../config/env.ts";
import { buildApplication } from "./composition.ts";
import type { Application } from "./composition.ts";

export const APPLICATION = Symbol("APPLICATION");

const fromApplication = <T>(
  token: abstract new (...args: never[]) => T,
  pick: (app: Application) => T,
) => ({
  provide: token,
  inject: [APPLICATION],
  useFactory: pick,
});

/**
 * Wires the framework-free use cases into Nest. The use cases themselves have no decorators; the
 * classes are only used as injection tokens.
 */
@Module({
  providers: [
    {
      provide: APPLICATION,
      inject: [MikroORM, APP_CONFIG],
      // The Nest provider is the PostgreSQL MikroORM instance, registered under the core token.
      useFactory: (orm: PostgreSqlMikroORM, config: AppConfig) => buildApplication(orm, config),
    },
    fromApplication(ProcessWagerTransaction, (app) => app.processWagerTransaction),
    fromApplication(CreateWallet, (app) => app.createWallet),
    fromApplication(ReconcileWallet, (app) => app.reconcileWallet),
    fromApplication(GetWallet, (app) => app.getWallet),
    fromApplication(GetLedgerPage, (app) => app.getLedgerPage),
    fromApplication(GetTransaction, (app) => app.getTransaction),
    fromApplication(GetTransactionByExternalId, (app) => app.getTransactionByExternalId),
  ],
  exports: [
    APPLICATION,
    ProcessWagerTransaction,
    CreateWallet,
    ReconcileWallet,
    GetWallet,
    GetLedgerPage,
    GetTransaction,
    GetTransactionByExternalId,
  ],
})
export class ApplicationModule {}
