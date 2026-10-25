import type { EventContext, IntegrationEvent } from "../../domain/events/integration-event.ts";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.ts";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.ts";
import { OutboxMessage } from "../../domain/messaging/outbox-message.ts";
import { Money } from "../../domain/shared/money.ts";
import type { MoneyProps } from "../../domain/shared/money.ts";
import { WagerTransaction } from "../../domain/wager/wager-transaction.ts";
import { Wallet } from "../../domain/wallet/wallet.ts";
import { WalletAlreadyExistsError } from "../errors.ts";
import type { Clock, IdGenerator } from "../ports/system.ts";
import type { Logger } from "../ports/telemetry.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import { requireUuid } from "../validation.ts";
import { walletView } from "../views.ts";
import type { WalletView } from "../views.ts";
import type { RequestContext } from "../request-context.ts";

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
}

/**
 * Wallet + OPENING transaction + CREDIT entry + events, in one SQL transaction. The database
 * decides the race between two creations for the same player and currency: the second INSERT
 * waits on the unique index and, once the first commits, ON CONFLICT DO NOTHING returns no row →
 * WalletAlreadyExistsError. There is no "exists?" pre-check, which would itself be racy.
 */
export class CreateWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
  ) {}

  async execute(command: CreateWalletCommand, context: RequestContext): Promise<WalletView> {
    const playerId = requireUuid("playerId", command.playerId);
    const initialBalance = Money.from(command.initialBalance);
    // Ids are generated once: if a COMMIT is lost with the connection and the retry finds the
    // wallet with *our* id, it was our own commit that went through, not a duplicate.
    const walletId = this.ids.next();
    const opening = initialBalance.isPositive()
      ? { transactionId: this.ids.next(), ledgerEntryId: this.ids.next() }
      : undefined;

    const view = await this.runner.run(async (scope) => {
      const at = this.clock.now();
      const wallet = Wallet.open({ id: walletId, playerId, initialBalance, at, opening });
      const entries = await scope.wallets.insertIfAbsent(wallet);
      if (entries === undefined) {
        const existing = await scope.wallets.findByPlayerAndCurrency(
          playerId,
          initialBalance.currency,
        );
        if (existing?.id === walletId) return walletView(existing);
        throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
      }
      if (opening !== undefined) {
        const transaction = WagerTransaction.opening({
          id: opening.transactionId,
          walletId,
          playerId,
          money: initialBalance,
          at,
        });
        await scope.transactions.insert(transaction);
        const eventContext = (): EventContext => ({
          eventId: this.ids.next(),
          correlationId: context.correlationId,
          causationId: context.causationId,
          occurredAt: at,
        });
        // Processed too, not only BalanceChanged: the OPENING is an applied transaction, and a
        // consumer must never see a balance change whose transactionId was never processed.
        const events: IntegrationEvent<unknown>[] = [
          WagerTransactionProcessed.from(transaction, eventContext()),
          ...entries.map((entry) => WalletBalanceChanged.from(wallet, entry, eventContext())),
        ];
        await scope.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
      }
      return walletView(wallet);
    });

    this.logger.info("wallet created", {
      walletId: view.id,
      correlationId: context.correlationId,
    });
    return view;
  }
}
