/**
 * Every failure that reaches a client is one of these. Global Constraint #3 —
 * no silent failures — means three things in practice:
 *   - `code` is stable and machine-readable (clients branch on it, never on prose)
 *   - `message` states what went wrong
 *   - `hint` states what to do about it
 *
 * An unexpected throw is converted to INTERNAL at the edge and logged with its
 * stack; it never leaks an internal message to the caller.
 *
 * The codes themselves, their statuses, and whether each is worth retrying live in
 * `errorcatalog.ts`, which is also what `GET /v1/errors` and `docs/api/errors.md`
 * are built from. There is deliberately no second list here to fall out of step.
 */
import { ERROR_CATALOG, type ErrorCode } from './errorcatalog.js';

export type { ErrorCode };

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string;
  readonly details: Record<string, unknown>;
  /** Whether replaying this exact request could plausibly succeed. See the catalog. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, hint: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.retryable = ERROR_CATALOG[code].retryable;
    this.hint = hint;
    this.details = details;
  }

  toBody() {
    return {
      error: { code: this.code, message: this.message, hint: this.hint, retryable: this.retryable, ...(Object.keys(this.details).length ? { details: this.details } : {}) },
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
