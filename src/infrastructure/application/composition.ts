import type { MikroORM } from "@mikro-orm/postgresql";
import type { Clock, IdGenerator, RandomSource, Sleeper } from "../../application/ports/system.ts";
import type { ApplicationMetrics, Logger } from "../../application/ports/telemetry.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import {
  GetLedgerPage,
  GetTransaction,
  GetTransactionByExternalId,
  GetWallet,
} from "../../application/queries/queries.ts";
import { TransactionRunner } from "../../application/transaction-runner.ts";
import { ProcessWagerTransaction } from "../../application/wager/process-wager-transaction.ts";
import { CreateWallet } from "../../application/wallet/create-wallet.ts";
import { ReconcileWallet } from "../../application/wallet/reconcile-wallet.ts";
import { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import type { PendingReferenceConfig, TransientRetryConfig } from "../config/env.ts";
import { InMemoryApplicationMetrics, JsonLineLogger } from "../observability/telemetry-adapters.ts";
import { MikroOrmUnitOfWork } from "../persistence/mikro-orm-unit-of-work.ts";
import {
  MathRandomSource,
  SystemClock,
  TimerSleeper,
  UuidV7IdGenerator,
} from "../system/system-adapters.ts";

export interface ApplicationConfig {
  readonly instanceId: string;
  readonly transientRetry: TransientRetryConfig;
  readonly pendingReference: PendingReferenceConfig;
}

/** Everything the use cases depend on; tests replace some (fixed clock, fault-injecting UoW). */
export interface ApplicationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: RandomSource;
  readonly sleeper: Sleeper;
  readonly logger: Logger;
  readonly metrics: ApplicationMetrics;
}

export interface Application {
  readonly processWagerTransaction: ProcessWagerTransaction;
  readonly createWallet: CreateWallet;
  readonly reconcileWallet: ReconcileWallet;
  readonly getWallet: GetWallet;
  readonly getLedgerPage: GetLedgerPage;
  readonly getTransaction: GetTransaction;
  readonly getTransactionByExternalId: GetTransactionByExternalId;
  readonly dependencies: ApplicationDependencies;
}

/** Composition root of the application layer, shared by the Nest module and the tests. */
export function buildApplication(
  orm: MikroORM,
  config: ApplicationConfig,
  overrides: Partial<ApplicationDependencies> = {},
): Application {
  const deps: ApplicationDependencies = {
    unitOfWork: overrides.unitOfWork ?? new MikroOrmUnitOfWork(orm),
    clock: overrides.clock ?? new SystemClock(),
    ids: overrides.ids ?? new UuidV7IdGenerator(),
    random: overrides.random ?? new MathRandomSource(),
    sleeper: overrides.sleeper ?? new TimerSleeper(),
    logger: overrides.logger ?? new JsonLineLogger({ instanceId: config.instanceId }),
    metrics: overrides.metrics ?? new InMemoryApplicationMetrics(),
  };
  const runner = new TransactionRunner(
    deps.unitOfWork,
    {
      maxAttempts: config.transientRetry.maxAttempts,
      backoff: ExponentialBackoff.of({
        baseMs: config.transientRetry.baseMs,
        maxMs: config.transientRetry.maxMs,
      }),
    },
    deps.sleeper,
    deps.random,
    deps.metrics,
    deps.logger,
  );
  return {
    processWagerTransaction: new ProcessWagerTransaction(
      runner,
      deps.clock,
      deps.ids,
      deps.random,
      {
        backoff: ExponentialBackoff.of({
          baseMs: config.pendingReference.baseMs,
          maxMs: config.pendingReference.maxMs,
        }),
        ttlMs: config.pendingReference.ttlMs,
      },
      deps.metrics,
      deps.logger,
    ),
    createWallet: new CreateWallet(runner, deps.clock, deps.ids, deps.logger),
    reconcileWallet: new ReconcileWallet(runner, deps.metrics, deps.logger),
    getWallet: new GetWallet(runner),
    getLedgerPage: new GetLedgerPage(runner),
    getTransaction: new GetTransaction(runner),
    getTransactionByExternalId: new GetTransactionByExternalId(runner),
    dependencies: deps,
  };
}
