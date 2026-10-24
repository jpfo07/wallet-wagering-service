import { describe, expect, test } from "bun:test";
import {
  CodeCategory,
  ERROR_CODE_CATALOG,
  ErrorCode,
  FAILURE_CODE_CATALOG,
  FailureCode,
  ProviderAction,
  isFailureCode,
} from "../../../../src/domain/shared/failure-code.ts";

describe("code taxonomy", () => {
  test("the list of failure codes is fixed (renaming one breaks providers, on purpose)", () => {
    const failureCodes: readonly string[] = Object.values(FailureCode);
    expect(failureCodes).toEqual([
      "INSUFFICIENT_FUNDS",
      "REVERSAL_WOULD_OVERDRAW",
      "REFERENCE_NOT_FOUND",
      "REFERENCE_ALREADY_REVERSED",
      "REFERENCE_HAS_ACTIVE_SETTLEMENT",
      "REFERENCE_KIND_NOT_ALLOWED",
      "REFERENCE_MISMATCH",
      "REFERENCE_NOT_PROCESSED",
      "AMOUNT_MISMATCH",
      "CURRENCY_MISMATCH",
      "WALLET_PLAYER_MISMATCH",
      "INTERNAL_PERMANENT_ERROR",
    ]);
  });

  test("the list of error codes is fixed", () => {
    const errorCodes: readonly string[] = Object.values(ErrorCode);
    expect(errorCodes).toEqual([
      "INVALID_PAYLOAD",
      "INVALID_AMOUNT",
      "INVALID_CURRENCY",
      "KIND_NOT_ALLOWED",
      "PROVIDER_RESERVED",
      "REFERENCE_REQUIRED",
      "REFERENCE_NOT_ALLOWED",
      "SELF_REFERENCE",
      "WALLET_NOT_FOUND",
      "IDEMPOTENCY_KEY_REUSED",
      "EXTERNAL_TRANSACTION_ID_CONFLICT",
      "WALLET_ALREADY_EXISTS",
      "TRANSIENT_FAILURE",
    ]);
  });

  test("every code has a category and a provider action", () => {
    for (const code of Object.values(FailureCode)) {
      expect(Object.values(CodeCategory)).toContain(FAILURE_CODE_CATALOG[code].category);
      expect(Object.values(ProviderAction)).toContain(FAILURE_CODE_CATALOG[code].providerAction);
    }
    for (const code of Object.values(ErrorCode)) {
      expect(Object.values(CodeCategory)).toContain(ERROR_CODE_CATALOG[code].category);
      expect(Object.values(ProviderAction)).toContain(ERROR_CODE_CATALOG[code].providerAction);
    }
  });

  test("only infrastructure failures are retryable as-is", () => {
    const retryable = [
      ...Object.values(FailureCode).filter(
        (code) => FAILURE_CODE_CATALOG[code].providerAction === ProviderAction.Retry,
      ),
      ...Object.values(ErrorCode).filter(
        (code) => ERROR_CODE_CATALOG[code].providerAction === ProviderAction.Retry,
      ),
    ];
    expect(retryable).toEqual([ErrorCode.TransientFailure]);
  });

  test("all persisted rejections are business rejections; FAILED is a permanent failure", () => {
    for (const code of Object.values(FailureCode)) {
      expect(FAILURE_CODE_CATALOG[code].category).toBe(
        code === FailureCode.InternalPermanentError
          ? CodeCategory.PermanentFailure
          : CodeCategory.BusinessRejection,
      );
    }
  });

  test("the active-settlement rejection tells the provider to fix (roll back the WIN first)", () => {
    expect(FAILURE_CODE_CATALOG[FailureCode.ReferenceHasActiveSettlement].providerAction).toBe(
      ProviderAction.Fix,
    );
  });

  test("isFailureCode", () => {
    expect(isFailureCode("INSUFFICIENT_FUNDS")).toBe(true);
    expect(isFailureCode("INVALID_PAYLOAD")).toBe(false);
  });
});
