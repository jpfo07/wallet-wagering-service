import type { EventContext } from "../../domain/events/integration-event.ts";
import { canonicalJson } from "../../domain/idempotency/canonical-json.ts";
import { checkIdempotency } from "../../domain/idempotency/idempotency-check.ts";
import { computeWagerPayloadHash, sha256Hex } from "../../domain/idempotency/payload-hash.ts";
import type { WagerPayloadFields } from "../../domain/idempotency/payload-hash.ts";
import { InboxMessage } from "../../domain/messaging/inbox-message.ts";
import { OutboxMessage } from "../../domain/messaging/outbox-message.ts";
import type { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import { ErrorCode } from "../../domain/shared/failure-code.ts";
import { Money } from "../../domain/shared/money.ts";
import type { MoneyProps } from "../../domain/shared/money.ts";
import type { ReferenceRetryPolicy } from "../../domain/wager/wager-settlement.ts";
import { isWagerTransactionKind } from "../../domain/wager/wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../../domain/wager/wager-transaction-status.ts";
import { InvalidWagerTransactionError } from "../../domain/wager/wager-transaction.errors.ts";
import { WagerTransaction } from "../../domain/wager/wager-transaction.ts";
import {
  ConcurrentInsertConflictError,
  IdempotencyConflictError,
  PoisonMessageError,
  WalletNotFoundError,
} from "../errors.ts";
import type { Clock, IdGenerator, RandomSource } from "../ports/system.ts";
import type { ApplicationMetrics, Logger } from "../ports/telemetry.ts";
import type { TransactionScope } from "../ports/unit-of-work.ts";
import type { RequestContext } from "../request-context.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import { optionalText, requireText, requireUuid } from "../validation.ts";
import { wagerTransactionResult } from "../views.ts";
import type { WagerTransactionResult } from "../views.ts";
import { settleUnderLock } from "./settle-under-lock.ts";

/** The same command for HTTP (body + Idempotency-Key header) and SQS (message `data`). */
export interface WagerTransactionCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}

/** Present only when the command came from SQS: recorded in the inbox, in the same transaction. */
export interface InboxDelivery {
  readonly consumerName: string;
  readonly messageId: string;
}

export interface PendingReferencePolicy {
  readonly backoff: ExponentialBackoff;
  readonly ttlMs: number;
}

interface PreparedCommand {
  readonly fields: WagerPayloadFields;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  /** Generated once and reused by every attempt (an ambiguous COMMIT then simply replays). */
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly delivery: (InboxDelivery & { readonly payloadHash: string }) | undefined;
}

interface Attempt {
  readonly result: WagerTransactionResult;
  readonly walletId: string;
}

/**
 * Processes one wager transaction, entirely inside one SQL transaction:
 *
 *   lock wallet → inbox (SQS) → idempotency → create → reference state → settle → insert
 *   transaction → ledger + versioned wallet update → outbox → inbox processed → COMMIT
 *
 * The wallet lock comes first: in READ COMMITTED every later SELECT sees what the previous holder
 * of the same lock committed, so the idempotency check and the reference state can't be stale.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly random: RandomSource,
    private readonly pendingReference: PendingReferencePolicy,
    private readonly metrics: ApplicationMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(
    command: WagerTransactionCommand,
    context: RequestContext,
    delivery?: InboxDelivery,
  ): Promise<WagerTransactionResult> {
    const prepared = this.prepare(command, delivery);
    const work = (scope: TransactionScope): Promise<Attempt> =>
      this.attempt(scope, prepared, context);
    let attempt: Attempt;
    try {
      attempt = await this.runner.run(work);
    } catch (error) {
      // Same key (or externalId) committed concurrently for another wallet: our lock did not
      // serialize us. Restart once; the new attempt sees the row and answers replay or conflict.
      if (!(error instanceof ConcurrentInsertConflictError)) throw error;
      this.logger.info("concurrent idempotency insert, restarting", {
        providerId: prepared.fields.providerId,
        walletId: prepared.fields.walletId,
        target: error.target,
        correlationId: context.correlationId,
      });
      attempt = await this.runner.run(work);
    }
    this.logger.info("wager transaction handled", {
      transactionId: attempt.result.transactionId,
      walletId: attempt.walletId,
      providerId: prepared.fields.providerId,
      status: attempt.result.status,
      failureCode: attempt.result.failureCode,
      idempotentReplay: attempt.result.idempotentReplay,
      correlationId: context.correlationId,
      messageId: delivery?.messageId,
    });
    return attempt.result;
  }

  /** Validation before any SQL: malformed input never opens a transaction. */
  private prepare(command: WagerTransactionCommand, delivery?: InboxDelivery): PreparedCommand {
    const kind = command.kind;
    if (!isWagerTransactionKind(kind)) {
      throw new InvalidWagerTransactionError(ErrorCode.InvalidPayload, "unknown kind");
    }
    const fields: WagerPayloadFields = {
      providerId: requireText("providerId", command.providerId),
      externalTransactionId: requireText("externalTransactionId", command.externalTransactionId),
      playerId: requireUuid("playerId", command.playerId),
      walletId: requireUuid("walletId", command.walletId),
      roundId: requireText("roundId", command.roundId),
      gameId: requireText("gameId", command.gameId),
      kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: optionalText(
        "referenceExternalTransactionId",
        command.referenceExternalTransactionId,
      ),
    };
    const idempotencyKey = requireText("idempotencyKey", command.idempotencyKey);
    const payloadHash = computeWagerPayloadHash(fields);
    const transactionId = this.ids.next();
    // Shape rules that do not depend on stored state (OPENING, reserved provider, references,
    // amounts). The instance is discarded: each attempt builds its own.
    WagerTransaction.create({
      ...fields,
      id: transactionId,
      idempotencyKey,
      payloadHash,
      createdAt: this.clock.now(),
    });
    return {
      fields,
      idempotencyKey,
      payloadHash,
      transactionId,
      ledgerEntryId: this.ids.next(),
      delivery:
        delivery === undefined
          ? undefined
          : {
              consumerName: requireText("consumerName", delivery.consumerName),
              messageId: requireText("messageId", delivery.messageId),
              payloadHash: inboxPayloadHash(fields, idempotencyKey),
            },
    };
  }

  private async attempt(
    scope: TransactionScope,
    prepared: PreparedCommand,
    context: RequestContext,
  ): Promise<Attempt> {
    const { fields, idempotencyKey, payloadHash } = prepared;

    // 1. Lock the wallet: the first statement of the transaction.
    const wallet = await scope.wallets.lockById(fields.walletId);
    if (wallet === undefined) throw new WalletNotFoundError(fields.walletId);
    const at = this.clock.now();

    // 2. Inbox (SQS only). A redelivery of the same message falls through to the replay below.
    let inboxToMark: InboxMessage | undefined;
    if (prepared.delivery !== undefined) {
      const { consumerName, messageId } = prepared.delivery;
      const received = await scope.inbox.receive(
        InboxMessage.receive({
          consumerName,
          messageId,
          payloadHash: prepared.delivery.payloadHash,
          receivedAt: at,
        }),
      );
      if (!received.message.matchesPayload(prepared.delivery.payloadHash)) {
        throw new PoisonMessageError(consumerName, messageId);
      }
      if (received.inserted) inboxToMark = received.message;
    }

    // 3. Idempotency, under the lock.
    const byKey = await scope.transactions.findByIdempotencyKey(fields.providerId, idempotencyKey);
    const byExternalId =
      byKey === undefined
        ? await scope.transactions.findByExternalId(fields.providerId, fields.externalTransactionId)
        : undefined;
    const decision = checkIdempotency({
      byKey,
      byExternalId,
      incoming: { providerId: fields.providerId, idempotencyKey, payloadHash },
    });
    if (decision.type === "CONFLICT") {
      this.metrics.idempotencyConflict();
      throw new IdempotencyConflictError(decision.code, decision.transaction.id);
    }
    if (decision.type === "REPLAY") {
      this.metrics.idempotentReplay();
      await this.markInbox(scope, inboxToMark, at);
      return {
        result: wagerTransactionResult(decision.transaction, true),
        walletId: wallet.id,
      };
    }

    // 4. New transaction: settle it against the locked wallet.
    const transaction = WagerTransaction.create({
      ...fields,
      id: prepared.transactionId,
      idempotencyKey,
      payloadHash,
      createdAt: at,
    });
    const versionRead = wallet.version;
    const { outcome, events } = await settleUnderLock(scope.transactions, {
      transaction,
      wallet,
      ledgerEntryId: prepared.ledgerEntryId,
      at,
      referenceRetry: this.referenceRetry(),
      eventContext: () => this.eventContext(context, at),
    });

    // 5. Persist everything in the same transaction.
    await scope.transactions.insert(transaction);
    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry !== undefined) {
      await scope.wallets.save(wallet, versionRead);
    }
    await scope.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
    await this.markInbox(scope, inboxToMark, at);
    return { result: wagerTransactionResult(transaction, false), walletId: wallet.id };
  }

  private async markInbox(
    scope: TransactionScope,
    message: InboxMessage | undefined,
    at: Date,
  ): Promise<void> {
    if (message === undefined) return;
    message.markProcessed(at);
    await scope.inbox.markProcessed(message);
  }

  private referenceRetry(): ReferenceRetryPolicy {
    return {
      backoff: this.pendingReference.backoff,
      ttlMs: this.pendingReference.ttlMs,
      random: () => this.random.next(),
    };
  }

  private eventContext(context: RequestContext, at: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: at,
    };
  }
}

/**
 * Inbox payload hash: SHA-256 of the canonical JSON of the whole message `data`, i.e. the business
 * fields plus the idempotencyKey. The same messageId with another key is also a poison message.
 */
export function inboxPayloadHash(fields: WagerPayloadFields, idempotencyKey: string): string {
  return sha256Hex(
    canonicalJson({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      idempotencyKey,
      playerId: fields.playerId,
      walletId: fields.walletId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: { amount: fields.money.amount, currency: fields.money.currency },
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    }),
  );
}
