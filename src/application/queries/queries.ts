import { TransactionNotFoundError, WalletNotFoundError, InvalidCommandError } from "../errors.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import { requirePositiveInteger, requireText, requireUuid } from "../validation.ts";
import { ledgerEntryView, transactionView, walletView } from "../views.ts";
import type { LedgerEntryView, TransactionView, WalletView } from "../views.ts";
import { assertActsAsProvider } from "../ports/provider-identity.ts";
import type { ProviderPrincipal } from "../ports/provider-identity.ts";

export const MAX_LEDGER_PAGE_LIMIT = 200;

export class GetWallet {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(walletId: string): Promise<WalletView> {
    const id = requireUuid("walletId", walletId);
    const wallet = await this.runner.run((scope) => scope.wallets.findById(id), {
      readOnly: true,
    });
    if (wallet === undefined) throw new WalletNotFoundError(id);
    return walletView(wallet);
  }
}

export interface LedgerPageQuery {
  readonly walletId: string;
  /** Cursor: the walletVersion of the last entry already seen (exclusive). */
  readonly afterVersion?: number | undefined;
  readonly limit: number;
}

export interface LedgerPage {
  readonly entries: readonly LedgerEntryView[];
  /** Present when there are more entries; pass it back as afterVersion. */
  readonly nextAfterVersion?: number;
}

/**
 * Keyset pagination on (wallet_id, wallet_version): stable under concurrent inserts and immune to
 * clock skew between instances (the version is assigned under the wallet lock).
 */
export class GetLedgerPage {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(query: LedgerPageQuery): Promise<LedgerPage> {
    const walletId = requireUuid("walletId", query.walletId);
    const limit = requirePositiveInteger("limit", query.limit, MAX_LEDGER_PAGE_LIMIT);
    const afterVersion = query.afterVersion;
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) {
      throw new InvalidCommandError("cursor must point to a non-negative wallet version");
    }
    const { wallet, entries } = await this.runner.run(
      async (scope) => ({
        wallet: await scope.wallets.findById(walletId),
        entries: await scope.ledger.page(walletId, { afterVersion, limit: limit + 1 }),
      }),
      { readOnly: true },
    );
    if (wallet === undefined) throw new WalletNotFoundError(walletId);
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(ledgerEntryView),
      ...(entries.length > limit && last !== undefined
        ? { nextAfterVersion: last.walletVersion }
        : {}),
    };
  }
}

export class GetTransaction {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(transactionId: string): Promise<TransactionView> {
    const id = requireUuid("transactionId", transactionId);
    const transaction = await this.runner.run((scope) => scope.transactions.findById(id), {
      readOnly: true,
    });
    if (transaction === undefined) throw new TransactionNotFoundError(id);
    return transactionView(transaction);
  }
}

/** Scoped by provider: one provider never sees another provider's transactions. */
export class GetTransactionByExternalId {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(
    providerId: string,
    externalTransactionId: string,
    principal?: ProviderPrincipal,
  ): Promise<TransactionView> {
    const provider = requireText("providerId", providerId);
    assertActsAsProvider(principal, provider);
    const externalId = requireText("externalTransactionId", externalTransactionId);
    const transaction = await this.runner.run(
      (scope) => scope.transactions.findByExternalId(provider, externalId),
      { readOnly: true },
    );
    if (transaction === undefined) {
      throw new TransactionNotFoundError(`${externalId} of provider ${provider}`);
    }
    return transactionView(transaction);
  }
}
