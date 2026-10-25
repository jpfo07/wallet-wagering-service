import { ApplicationError, IdempotencyConflictError } from "../../application/errors.ts";
import { ValidationError } from "../../domain/shared/domain-error.ts";
import { CodeCategory, ERROR_CODE_CATALOG, ErrorCode } from "../../domain/shared/failure-code.ts";
import { statusForCategory } from "./http-status.ts";

/** Codes that exist only at the HTTP edge (no use case ever raises them). */
export enum HttpErrorCode {
  RouteNotFound = "ROUTE_NOT_FOUND",
  InternalError = "INTERNAL_ERROR",
}

export interface ErrorDetail {
  readonly path: string;
  readonly message: string;
}

/** The one error body of the API (400, 401, 403, 404, 409, 500, 503). */
export interface ApiErrorBody {
  readonly error: ErrorCode | HttpErrorCode;
  readonly message: string;
  readonly correlationId: string;
  /** The existing transaction, on an idempotency conflict. */
  readonly transactionId?: string;
  /** Which fields failed the shape validation. */
  readonly details?: readonly ErrorDetail[];
}

/** Malformed request caught by the HTTP adapter (body/header/query shape, cursor): 400. */
export class InvalidRequestError extends Error {
  constructor(
    message: string,
    readonly details: readonly ErrorDetail[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Framework errors reduced to what the mapping needs (a Nest HttpException, structurally). */
export interface FrameworkHttpError {
  readonly status: number;
  readonly message: string;
}

export interface MappedError {
  readonly status: number;
  readonly body: Omit<ApiErrorBody, "correlationId">;
  /** 503: the client may resend the same request after Retry-After. */
  readonly retryable: boolean;
  /** 5xx are logged by the filter; 4xx are the client's problem. */
  readonly log: "none" | "warn" | "error";
}

const ERROR_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

function isErrorCode(code: string): code is ErrorCode {
  return ERROR_CODES.has(code);
}

/**
 * Error → status + body, by the category of the code (never by individual code), so every endpoint
 * answers the same situation with the same status. Anything unknown is a 500 with a generic
 * message: internal details (SQL, constraint names) never leak to the client.
 */
export function mapError(error: unknown, framework?: FrameworkHttpError): MappedError {
  if (error instanceof InvalidRequestError) {
    return {
      status: 400,
      body: {
        error: ErrorCode.InvalidPayload,
        message: error.message,
        ...(error.details.length === 0 ? {} : { details: error.details }),
      },
      retryable: false,
      log: "none",
    };
  }
  if (error instanceof ValidationError || error instanceof ApplicationError) {
    // instanceof on the generic classes yields `any` type arguments; pin the defaults.
    const code: string = (error as ValidationError | ApplicationError).code;
    if (isErrorCode(code)) {
      const { category } = ERROR_CODE_CATALOG[code];
      const transient = category === CodeCategory.Transient;
      return {
        status: statusForCategory(category),
        body: {
          error: code,
          message: transient ? "temporarily unavailable, retry later" : error.message,
          ...(error instanceof IdempotencyConflictError
            ? { transactionId: error.existingTransactionId }
            : {}),
        },
        retryable: transient,
        log: transient ? "warn" : "none",
      };
    }
  }
  if (framework !== undefined && framework.status < 500) {
    // Unknown route, malformed JSON, body too large...: the framework's own 4xx.
    return framework.status === 404
      ? {
          status: 404,
          body: { error: HttpErrorCode.RouteNotFound, message: "route not found" },
          retryable: false,
          log: "none",
        }
      : {
          status: 400,
          body: { error: ErrorCode.InvalidPayload, message: framework.message },
          retryable: false,
          log: "none",
        };
  }
  return {
    status: 500,
    body: { error: HttpErrorCode.InternalError, message: "internal error" },
    retryable: false,
    log: "error",
  };
}
