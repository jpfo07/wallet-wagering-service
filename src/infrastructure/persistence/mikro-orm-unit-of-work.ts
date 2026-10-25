import { IsolationLevel } from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import {
  ApplicationError,
  ConcurrentInsertConflictError,
  PersistenceIntegrityError,
  TransientPersistenceError,
} from "../../application/errors.ts";
import type {
  TransactionScope,
  UnitOfWork,
  UnitOfWorkOptions,
} from "../../application/ports/unit-of-work.ts";
import { DomainError } from "../../domain/shared/domain-error.ts";
import { classifyPersistenceError } from "./persistence-error-classifier.ts";
import { MikroOrmLedgerRepository } from "./repositories/mikro-orm-ledger.repository.ts";
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from "./repositories/mikro-orm-messaging.repositories.ts";
import { MikroOrmWagerTransactionRepository } from "./repositories/mikro-orm-wager-transaction.repository.ts";
import { MikroOrmWalletRepository } from "./repositories/mikro-orm-wallet.repository.ts";

/**
 * One call = one SQL transaction in READ COMMITTED, on a fresh EntityManager fork (nothing cached
 * from a previous attempt can be read after the wallet lock). Errors from the driver, including
 * the deferred checks that fire at COMMIT, leave translated by SQLSTATE.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options: UnitOfWorkOptions = {},
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(createScope(em)), {
        isolationLevel: IsolationLevel.READ_COMMITTED,
        readOnly: options.readOnly ?? false,
      });
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}

export function createScope(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

export function translatePersistenceError(error: unknown): unknown {
  // Thrown by the work itself (business outcome or bug): already meaningful.
  if (error instanceof ApplicationError || error instanceof DomainError) return error;
  const classified = classifyPersistenceError(error);
  switch (classified.kind) {
    case "transient":
      return new TransientPersistenceError(classified.reason, error);
    case "concurrent-insert":
      return new ConcurrentInsertConflictError(classified.target, error);
    case "integrity":
      return new PersistenceIntegrityError(classified.sqlState, classified.constraint, error);
    case "other":
      return error;
  }
}
