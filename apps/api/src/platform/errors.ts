/**
 * Application errors and their RFC 9457 `application/problem+json` rendering.
 *
 * `api-standards.md` §5. Two rules matter most:
 *   - every error response carries a request ID;
 *   - responses never expose stack traces or internal detail.
 */

export type ProblemCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "GONE"
  | "CONFLICT"
  | "PRECONDITION_REQUIRED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Readonly<Record<ProblemCode, number>> = {
  // api-standards.md §4: 400 only for unparseable requests; 422 for valid JSON
  // that fails validation or a business rule.
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  GONE: 410,
  CONFLICT: 409,
  // "You must state which version you are replacing, and did not." Distinct
  // from 409: nothing conflicted, the caller never declared an intent.
  PRECONDITION_REQUIRED: 428,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface ProblemDetail {
  readonly field?: string;
  readonly message: string;
}

/**
 * An error that is safe to render to a client.
 *
 * Anything thrown that is *not* an `AppError` is treated as unexpected and
 * rendered as a generic 500, so an internal failure cannot leak its message.
 */
export class AppError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly details: readonly ProblemDetail[];

  constructor(
    code: ProblemCode,
    message: string,
    details: readonly ProblemDetail[] = [],
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  static validation(message: string, details: readonly ProblemDetail[] = []) {
    return new AppError("VALIDATION_ERROR", message, details);
  }

  static unauthenticated(message = "Authentication required") {
    return new AppError("UNAUTHENTICATED", message);
  }

  /**
   * Authorization failure.
   *
   * `backend-standards.md` §5: permission is checked *before* existence, so a
   * cross-tenant probe returns 403 rather than a 404 that would confirm the
   * resource exists.
   */
  static forbidden(message = "Not permitted") {
    return new AppError("FORBIDDEN", message);
  }

  static not_found(message = "Not found") {
    return new AppError("NOT_FOUND", message);
  }

  static upstream_unavailable(message: string) {
    return new AppError("UPSTREAM_UNAVAILABLE", message);
  }
}

/** The RFC 9457 body shape. */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: ProblemCode;
  readonly request_id: string;
  readonly errors?: readonly ProblemDetail[];
}

const TITLE_BY_CODE: Readonly<Record<ProblemCode, string>> = {
  BAD_REQUEST: "Malformed request",
  VALIDATION_ERROR: "Validation failed",
  UNAUTHENTICATED: "Authentication required",
  FORBIDDEN: "Forbidden",
  NOT_FOUND: "Not found",
  GONE: "No longer available",
  CONFLICT: "Conflict",
  PRECONDITION_REQUIRED: "Precondition required",
  PAYLOAD_TOO_LARGE: "Request body too large",
  UNSUPPORTED_MEDIA_TYPE: "Unsupported media type",
  RATE_LIMITED: "Too many requests",
  UPSTREAM_UNAVAILABLE: "Upstream unavailable",
  INTERNAL_ERROR: "Internal server error",
};

/**
 * Body-parser failures are *client* errors, not internal faults.
 *
 * Without this mapping an oversized upload would be rendered as a 500 and
 * logged as an internal error, hiding a caller mistake inside the service's
 * own error budget. The message is taken from our table, never from the
 * thrown error, so nothing internal leaks.
 */
function from_body_parser_error(error: unknown): AppError | null {
  if (typeof error !== "object" || error === null) return null;

  const { type, status } = error as { type?: unknown; status?: unknown };

  if (type === "entity.too.large" || status === 413) {
    return new AppError("PAYLOAD_TOO_LARGE", "Request body exceeds the 1MB limit");
  }
  if (type === "entity.parse.failed" || type === "encoding.unsupported") {
    return new AppError("BAD_REQUEST", "Request body could not be parsed");
  }
  if (type === "charset.unsupported" || status === 415) {
    return new AppError("UNSUPPORTED_MEDIA_TYPE", "Unsupported content type");
  }
  return null;
}

/**
 * Render an error as a problem document.
 *
 * Unknown errors collapse to a generic INTERNAL_ERROR: the caller learns a
 * request ID to quote, and nothing about what actually broke.
 */
export function to_problem_body(error: unknown, request_id: string): ProblemBody {
  const app_error =
    error instanceof AppError
      ? error
      : (from_body_parser_error(error) ??
        new AppError("INTERNAL_ERROR", "An unexpected error occurred"));

  return {
    type: `https://errors.bullion.example/${app_error.code.toLowerCase()}`,
    title: TITLE_BY_CODE[app_error.code],
    status: app_error.status,
    detail: app_error.message,
    code: app_error.code,
    request_id,
    ...(app_error.details.length > 0 ? { errors: app_error.details } : {}),
  };
}
