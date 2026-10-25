import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./repositories.ts";

/** The repositories of one SQL transaction. */
export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  readonly readOnly?: boolean;
}

/**
 * Runs `work` in exactly one SQL transaction (READ COMMITTED) with a fresh persistence context:
 * commit when it returns, rollback when it throws. Driver errors come out translated
 * (TransientPersistenceError, ConcurrentInsertConflictError, PersistenceIntegrityError); one call
 * is one attempt, retries belong to the caller.
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
