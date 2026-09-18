/**
 * Every failure that reaches a client is one of these. Global Constraint #3 —
 * no silent failures — means three things in practice:
 *   - `code` is stable and machine-readable (clients branch on it, never on prose)
 *   - `message` states what went wrong
 *   - `hint` states what to do about it
 *
 * An unexpected throw is converted to INTERNAL at the edge and logged with its
 * stack; it never leaks an internal message to the caller.
 */

export type ErrorCode =
  // auth / authz
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'SESSION_EXPIRED'
  | 'FORBIDDEN'
  | 'NO_ORG_CONTEXT'
  | 'NOT_A_MEMBER'
  // request shape
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  // policy
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENT_REQUEST_IN_PROGRESS'
  | 'VERIFICATION_REQUIRED'
  | 'SPEC_TOO_LARGE'
  // compilation (surfaced from @qsynth/core)
  //
  // These mirror QsynthErrorCode one-for-one rather than collapsing into a single
  // COMPILE_FAILED, so a client can tell "your syntax is wrong" from "your design does
  // not fit the budget you declared" from "the circuit does not implement your spec"
  // without parsing prose. `fromCompiler` in routes/compile.ts relies on the names
  // matching exactly.
  | 'COMPILE_FAILED'
  | 'PARSE_ERROR'
  | 'UNSUPPORTED_CONSTRUCT'
  | 'INVALID_SPEC'
  | 'BUDGET_EXCEEDED'
  | 'VERIFICATION_FAILED'
  // catch-all
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  NO_ORG_CONTEXT: 400,
  NOT_A_MEMBER: 403,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDEMPOTENT_REQUEST_IN_PROGRESS: 409,
  VERIFICATION_REQUIRED: 403,
  SPEC_TOO_LARGE: 413,
  COMPILE_FAILED: 422,
  PARSE_ERROR: 422,
  UNSUPPORTED_CONSTRUCT: 422,
  INVALID_SPEC: 422,
  BUDGET_EXCEEDED: 422,
  VERIFICATION_FAILED: 422,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, hint: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.hint = hint;
    this.details = details;
  }

  toBody() {
    return {
      error: { code: this.code, message: this.message, hint: this.hint, ...(Object.keys(this.details).length ? { details: this.details } : {}) },
    };
  }
}

export const unauthenticated = (hint = 'Send a session bearer token or an API key in the Authorization header.') =>
  new ApiError('UNAUTHENTICATED', 'Authentication is required for this endpoint.', hint);

export const forbidden = (need: string) =>
  new ApiError('FORBIDDEN', `Your role does not grant "${need}".`, `Ask an organization owner or admin to grant a role that includes "${need}".`, { required: need });

export const notFound = (what: string) =>
  new ApiError('NOT_FOUND', `${what} was not found.`, 'Check the identifier, and that it belongs to the organization you are acting in.');

export const invalid = (message: string, hint: string, details: Record<string, unknown> = {}) =>
  new ApiError('INVALID_REQUEST', message, hint, details);
