/**
 * Business outcomes persisted on a WagerTransaction (REJECTED / FAILED). Stable, machine-readable:
 * renaming one breaks every provider that branches on it.
 */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReferenceHasActiveSettlement = "REFERENCE_HAS_ACTIVE_SETTLEMENT",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  InternalPermanentError = "INTERNAL_PERMANENT_ERROR",
}

export type RejectionCode = Exclude<FailureCode, FailureCode.InternalPermanentError>;
export type PermanentFailureCode = FailureCode.InternalPermanentError;

/** Outcomes that never become a persisted transaction (bad input, conflicts, infrastructure). */
export enum ErrorCode {
  InvalidPayload = "INVALID_PAYLOAD",
  InvalidAmount = "INVALID_AMOUNT",
  InvalidCurrency = "INVALID_CURRENCY",
  KindNotAllowed = "KIND_NOT_ALLOWED",
  ProviderReserved = "PROVIDER_RESERVED",
  ReferenceRequired = "REFERENCE_REQUIRED",
  ReferenceNotAllowed = "REFERENCE_NOT_ALLOWED",
  SelfReference = "SELF_REFERENCE",
  WalletNotFound = "WALLET_NOT_FOUND",
  TransactionNotFound = "TRANSACTION_NOT_FOUND",
  IdempotencyKeyReused = "IDEMPOTENCY_KEY_REUSED",
  ExternalTransactionIdConflict = "EXTERNAL_TRANSACTION_ID_CONFLICT",
  WalletAlreadyExists = "WALLET_ALREADY_EXISTS",
  TransientFailure = "TRANSIENT_FAILURE",
  Unauthenticated = "UNAUTHENTICATED",
  ProviderIdentityMismatch = "PROVIDER_IDENTITY_MISMATCH",
}

/** Transport adapters map categories (never individual codes) to HTTP status / SQS handling. */
export enum CodeCategory {
  BusinessRejection = "BUSINESS_REJECTION",
  PermanentFailure = "PERMANENT_FAILURE",
  InvalidPayload = "INVALID_PAYLOAD",
  NotFound = "NOT_FOUND",
  Conflict = "CONFLICT",
  Transient = "TRANSIENT",
  /** No valid provider credentials (only once a real identity adapter is plugged in). */
  Unauthenticated = "UNAUTHENTICATED",
  /** Authenticated, but acting on behalf of another provider. */
  Forbidden = "FORBIDDEN",
}

/**
 * What the provider should do next.
 * RETRY: resend the same request (same key) later; it is safe.
 * FIX: send a new, corrected request (new key and new externalTransactionId).
 * GIVE_UP: the outcome is final; resending only replays it.
 */
export enum ProviderAction {
  Retry = "RETRY",
  Fix = "FIX",
  GiveUp = "GIVE_UP",
}

export interface CodeDescriptor {
  readonly category: CodeCategory;
  readonly providerAction: ProviderAction;
}

const rejection = (providerAction: ProviderAction): CodeDescriptor => ({
  category: CodeCategory.BusinessRejection,
  providerAction,
});

export const FAILURE_CODE_CATALOG: Readonly<Record<FailureCode, CodeDescriptor>> = Object.freeze({
  [FailureCode.InsufficientFunds]: rejection(ProviderAction.GiveUp),
  [FailureCode.ReversalWouldOverdraw]: rejection(ProviderAction.GiveUp),
  [FailureCode.ReferenceNotFound]: rejection(ProviderAction.Fix),
  [FailureCode.ReferenceAlreadyReversed]: rejection(ProviderAction.GiveUp),
  [FailureCode.ReferenceHasActiveSettlement]: rejection(ProviderAction.Fix),
  [FailureCode.ReferenceKindNotAllowed]: rejection(ProviderAction.Fix),
  [FailureCode.ReferenceMismatch]: rejection(ProviderAction.Fix),
  [FailureCode.ReferenceNotProcessed]: rejection(ProviderAction.GiveUp),
  [FailureCode.AmountMismatch]: rejection(ProviderAction.Fix),
  [FailureCode.CurrencyMismatch]: rejection(ProviderAction.Fix),
  [FailureCode.WalletPlayerMismatch]: rejection(ProviderAction.Fix),
  [FailureCode.InternalPermanentError]: {
    category: CodeCategory.PermanentFailure,
    providerAction: ProviderAction.GiveUp,
  },
});

const invalid: CodeDescriptor = {
  category: CodeCategory.InvalidPayload,
  providerAction: ProviderAction.Fix,
};

export const ERROR_CODE_CATALOG: Readonly<Record<ErrorCode, CodeDescriptor>> = Object.freeze({
  [ErrorCode.InvalidPayload]: invalid,
  [ErrorCode.InvalidAmount]: invalid,
  [ErrorCode.InvalidCurrency]: invalid,
  [ErrorCode.KindNotAllowed]: invalid,
  [ErrorCode.ProviderReserved]: invalid,
  [ErrorCode.ReferenceRequired]: invalid,
  [ErrorCode.ReferenceNotAllowed]: invalid,
  [ErrorCode.SelfReference]: invalid,
  [ErrorCode.WalletNotFound]: {
    category: CodeCategory.NotFound,
    providerAction: ProviderAction.Fix,
  },
  [ErrorCode.TransactionNotFound]: {
    category: CodeCategory.NotFound,
    providerAction: ProviderAction.Fix,
  },
  [ErrorCode.IdempotencyKeyReused]: {
    category: CodeCategory.Conflict,
    providerAction: ProviderAction.Fix,
  },
  [ErrorCode.ExternalTransactionIdConflict]: {
    category: CodeCategory.Conflict,
    providerAction: ProviderAction.Fix,
  },
  [ErrorCode.WalletAlreadyExists]: {
    category: CodeCategory.Conflict,
    providerAction: ProviderAction.GiveUp,
  },
  [ErrorCode.TransientFailure]: {
    category: CodeCategory.Transient,
    providerAction: ProviderAction.Retry,
  },
  [ErrorCode.Unauthenticated]: {
    category: CodeCategory.Unauthenticated,
    providerAction: ProviderAction.Fix,
  },
  [ErrorCode.ProviderIdentityMismatch]: {
    category: CodeCategory.Forbidden,
    providerAction: ProviderAction.Fix,
  },
});

const FAILURE_CODES: ReadonlySet<string> = new Set(Object.values(FailureCode));

export function isFailureCode(value: string): value is FailureCode {
  return FAILURE_CODES.has(value);
}
