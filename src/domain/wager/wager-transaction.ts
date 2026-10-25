import { computeWagerPayloadHash, PAYLOAD_HASH_PATTERN } from "../idempotency/payload-hash.ts";
import { InvalidOperationError } from "../shared/domain-error.ts";
import { ErrorCode } from "../shared/failure-code.ts";
import type { FailureCode, PermanentFailureCode, RejectionCode } from "../shared/failure-code.ts";
import type { Money } from "../shared/money.ts";
import { LedgerDirection } from "../wallet/ledger-direction.ts";
import { isWagerTransactionKind, WagerTransactionKind } from "./wager-transaction-kind.ts";
import { TERMINAL_STATUSES, WagerTransactionStatus } from "./wager-transaction-status.ts";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "./wager-transaction.errors.ts";

/** Reserved for internal transactions (OPENING); rejected when sent by a provider. */
export const INTERNAL_PROVIDER_ID = "internal";

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** Provider-side id of the referenced transaction, not the internal id. */
  readonly referenceExternalTransactionId?: string | undefined;
  /** Tracing metadata of the request that created it; not a business field (outside payloadHash). */
  readonly correlationId?: string | undefined;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly processedAt?: Date | undefined;
  /** Wallet balance observed when the outcome was decided; replays return it unchanged. */
  readonly observedBalance?: Money | undefined;
  readonly referenceAttempts: number;
  readonly nextReferenceCheckAt?: Date | undefined;
  readonly referenceExpiresAt?: Date | undefined;
  readonly updatedAt: Date;
}

const REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Valid transitions (anything else throws InvalidTransactionStateError):
 *
 *   PENDING           → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED, or reschedule (stays PENDING_REFERENCE)
 *   PROCESSED, REJECTED, FAILED → terminal
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly correlationId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceCheckAt: Date | undefined;
  private _referenceExpiresAt: Date | undefined;
  private _updatedAt: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.correlationId = state.correlationId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceCheckAt = state.nextReferenceCheckAt;
    this._referenceExpiresAt = state.referenceExpiresAt;
    this._updatedAt = state.updatedAt;
  }

  /** Born PENDING. Validates the request shape that does not depend on any stored state. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
      updatedAt: props.createdAt,
    });
  }

  /** The internal OPENING credit of a new wallet, already PROCESSED (used by CreateWallet only). */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    at: Date;
    correlationId?: string | undefined;
  }): WagerTransaction {
    const { id, walletId, playerId, money, at, correlationId } = props;
    if (!money.isPositive()) {
      throw new InvalidOperationError("an OPENING transaction requires a positive amount");
    }
    const fields = {
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${walletId}`,
      playerId,
      walletId,
      roundId: "opening",
      gameId: "opening",
      kind: WagerTransactionKind.Opening,
      money,
    };
    return new WagerTransaction({
      ...fields,
      id,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${walletId}`,
      payloadHash: computeWagerPayloadHash(fields),
      correlationId,
      createdAt: at,
      status: WagerTransactionStatus.Processed,
      processedAt: at,
      observedBalance: money,
      referenceAttempts: 0,
      updatedAt: at,
    });
  }

  /** Rebuilds persisted state; does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  get referenceExpiresAt(): Date | undefined {
    return this._referenceExpiresAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions

  markProcessed(props: {
    referenceTransactionId: string | undefined;
    observedBalance: Money;
    at: Date;
  }): void {
    this.assertTransition("markProcessed", [
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.PendingReference,
    ]);
    if ((props.referenceTransactionId === undefined) !== !this.hasReference()) {
      throw new InvalidOperationError(
        `transaction ${this.id}: referenceTransactionId must be given exactly when a reference was informed`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._observedBalance = props.observedBalance;
    this._processedAt = props.at;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = props.at;
  }

  reject(props: {
    code: RejectionCode;
    observedBalance: Money;
    referenceTransactionId?: string | undefined;
    at: Date;
  }): void {
    this.assertTransition("reject", [
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.PendingReference,
    ]);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = props.code;
    this._observedBalance = props.observedBalance;
    this._referenceTransactionId = props.referenceTransactionId;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = props.at;
  }

  markPendingReference(props: {
    observedBalance: Money;
    nextCheckAt: Date;
    expiresAt: Date;
    at: Date;
  }): void {
    this.assertTransition("markPendingReference", [WagerTransactionStatus.Pending]);
    if (!this.hasReference()) {
      throw new InvalidOperationError(`transaction ${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = props.observedBalance;
    this._referenceAttempts = 0;
    this._nextReferenceCheckAt = props.nextCheckAt;
    this._referenceExpiresAt = props.expiresAt;
    this._updatedAt = props.at;
  }

  /** The reference is still missing: stays PENDING_REFERENCE and schedules the next check. */
  scheduleNextReferenceCheck(props: { nextCheckAt: Date; at: Date }): void {
    this.assertTransition("scheduleNextReferenceCheck", [WagerTransactionStatus.PendingReference]);
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = props.nextCheckAt;
    this._updatedAt = props.at;
  }

  fail(props: { code: PermanentFailureCode; at: Date }): void {
    this.assertTransition("fail", [
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.PendingReference,
    ]);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = props.code;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = props.at;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false for LOSS: it records the outcome without moving the balance. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  acceptsReference(): boolean {
    return REFERENCE_KINDS[this.kind].length > 0;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  /** Kinds this transaction may reference (empty when it takes no reference). */
  allowedReferenceKinds(): readonly WagerTransactionKind[] {
    return REFERENCE_KINDS[this.kind];
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** PENDING_REFERENCE and its next check is due (re-read under the wallet lock by the worker). */
  isReferenceCheckDue(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextReferenceCheckAt !== undefined &&
      now.getTime() >= this._nextReferenceCheckAt.getTime()
    );
  }

  isReferenceExpired(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._referenceExpiresAt !== undefined &&
      now.getTime() >= this._referenceExpiresAt.getTime()
    );
  }

  /**
   * BET → DEBIT; WIN, REFUND, OPENING → CREDIT; ROLLBACK → the inverse of what the reference did
   * (ROLLBACK of BET credits; ROLLBACK of WIN or REFUND debits). LOSS has no direction.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidOperationError("LOSS does not move the balance");
      case WagerTransactionKind.Rollback: {
        if (reference === undefined || !this.allowedReferenceKinds().includes(reference.kind)) {
          throw new InvalidOperationError(
            "ROLLBACK direction requires a BET, WIN or REFUND reference",
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertTransition(
    transition: string,
    allowedFrom: readonly WagerTransactionStatus[],
  ): void {
    if (!allowedFrom.includes(this._status)) {
      throw new InvalidTransactionStateError(this.id, this._status, transition);
    }
  }

  private static validate(props: CreateWagerTransactionProps): void {
    const required = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidWagerTransactionError(ErrorCode.InvalidPayload, `${field} is required`);
      }
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidOperationError("payloadHash must be a lowercase hex SHA-256");
    }
    if (!isWagerTransactionKind(props.kind)) {
      throw new InvalidWagerTransactionError(ErrorCode.InvalidPayload, "unknown kind");
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        ErrorCode.KindNotAllowed,
        "OPENING is internal and cannot be submitted",
      );
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(
        ErrorCode.ProviderReserved,
        `providerId "${INTERNAL_PROVIDER_ID}" is reserved`,
      );
    }

    const reference = props.referenceExternalTransactionId;
    const acceptedKinds = REFERENCE_KINDS[props.kind];
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (reference === undefined) {
      if (requiresReference) {
        throw new InvalidWagerTransactionError(
          ErrorCode.ReferenceRequired,
          `${props.kind} requires referenceExternalTransactionId`,
        );
      }
    } else {
      if (acceptedKinds.length === 0) {
        throw new InvalidWagerTransactionError(
          ErrorCode.ReferenceNotAllowed,
          `${props.kind} does not take a reference`,
        );
      }
      if (reference.trim() === "") {
        throw new InvalidWagerTransactionError(
          ErrorCode.InvalidPayload,
          "referenceExternalTransactionId must not be empty",
        );
      }
      if (reference === props.externalTransactionId) {
        throw new InvalidWagerTransactionError(
          ErrorCode.SelfReference,
          "a transaction cannot reference itself",
        );
      }
    }

    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError(
        ErrorCode.InvalidAmount,
        "amount must not be negative",
      );
    }
    if (props.kind !== WagerTransactionKind.Loss && props.money.isZero()) {
      throw new InvalidWagerTransactionError(
        ErrorCode.InvalidAmount,
        `${props.kind} requires an amount greater than zero`,
      );
    }
  }
}
