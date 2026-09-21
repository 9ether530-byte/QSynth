/**
 * The error-code table — the public half of the API contract.
 *
 * This file is the single source of truth for three things that used to be three
 * separate lists: the set of codes, the HTTP status each maps to, and what a caller
 * should do about it. Deriving the status from the table rather than keeping a parallel
 * `Record<ErrorCode, number>` removes the one failure mode that matters here — a code
 * that means "you sent nonsense" quietly answering 500, or the reverse.
 *
 * `retryable` answers exactly one question: *is replaying this request, unchanged, ever
 * likely to succeed?* It is not "was this our fault". A 500 is retryable because the next
 * attempt may hit a healthy path; a 401 is not, because the same credentials will fail
 * the same way; a 422 is not, because the request itself is what is wrong. Clients use it
 * to decide between backoff and surfacing the error, so an over-generous `true` here
 * turns a client bug into a retry storm.
 *
 * `docs/api/errors.md` is generated from this table and pinned by a test, so the
 * documentation cannot drift from the behaviour.
 */

export interface ErrorSpec {
  /** HTTP status returned with this code. */
  readonly status: number;
  /** Whether replaying the identical request could plausibly succeed later. */
  readonly retryable: boolean;
  /** What happened, in terms of the caller's request. */
  readonly meaning: string;
  /** What the caller should do next. */
  readonly resolution: string;
  /** Grouping for the generated reference. */
  readonly category: 'authentication' | 'authorization' | 'request' | 'policy' | 'compilation' | 'server';
}

export const ERROR_CATALOG = {
  UNAUTHENTICATED: {
    status: 401,
    retryable: false,
    category: 'authentication',
    meaning: 'No credential was presented, or the API key presented is unknown, revoked, or expired.',
    resolution: 'Send `Authorization: Bearer <session token or API key>`. Issue a new key if the old one was revoked.',
  },
  INVALID_CREDENTIALS: {
    status: 401,
    retryable: false,
    category: 'authentication',
    meaning: 'The email and password combination was not accepted.',
    resolution: 'Check the address and password. The response is identical for an unknown address and a wrong password, by design.',
  },
  SESSION_EXPIRED: {
    status: 401,
    retryable: false,
    category: 'authentication',
    meaning: 'The session token is no longer valid — it expired or was logged out.',
    resolution: 'Sign in again to obtain a new session token.',
  },
  FORBIDDEN: {
    status: 403,
    retryable: false,
    category: 'authorization',
    meaning: 'The credential is valid but does not carry the permission this endpoint requires. `details.required` names it.',
    resolution: 'Ask an owner or admin for a role that includes the permission, or use an API key issued with that scope.',
  },
  NO_ORG_CONTEXT: {
    status: 400,
    retryable: false,
    category: 'authorization',
    meaning: 'The caller belongs to more than one organization and did not say which one the request acts in. `details.organizations` lists the candidates.',
    resolution: 'Repeat the request with an `X-Org-Id` header naming one of them.',
  },
  NOT_A_MEMBER: {
    status: 403,
    retryable: false,
    category: 'authorization',
    meaning: 'The caller is not a member of the organization in `X-Org-Id`. The same answer is given when no such organization exists, so that ids cannot be probed.',
    resolution: 'Drop the header to use your own organization, or ask for an invitation.',
  },
  INVALID_REQUEST: {
    status: 400,
    retryable: false,
    category: 'request',
    meaning: 'The request was malformed: a missing or mistyped field, an unparseable body, or a method the path does not support.',
    resolution: 'Read `message` — it names the offending field — and correct the request before retrying.',
  },
  NOT_FOUND: {
    status: 404,
    retryable: false,
    category: 'request',
    meaning: 'No such resource in the organization you are acting in. A resource belonging to another tenant is reported the same way.',
    resolution: 'Check the identifier, and that `X-Org-Id` names the organization that owns it.',
  },
  CONFLICT: {
    status: 409,
    retryable: false,
    category: 'request',
    meaning: 'The request contradicts the current state — for example an email that is already registered.',
    resolution: 'Read `message`; the resolution is specific to the conflict.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    retryable: false,
    category: 'request',
    meaning: 'A body was sent with a Content-Type other than application/json.',
    resolution: 'Send `Content-Type: application/json`.',
  },
  RATE_LIMITED: {
    status: 429,
    retryable: true,
    category: 'policy',
    meaning: 'Too many requests in the current window. `Retry-After` and `RateLimit-Reset` both give the seconds remaining.',
    resolution: 'Wait for the window to reset, then retry. Watch `RateLimit-Remaining` on successful responses to avoid reaching this at all.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    retryable: false,
    category: 'policy',
    meaning: 'This `Idempotency-Key` was already used for a request with a different body.',
    resolution: 'Use a fresh key per distinct request; reuse a key only to retry the identical one.',
  },
  IDEMPOTENT_REQUEST_IN_PROGRESS: {
    status: 409,
    retryable: true,
    category: 'policy',
    meaning: 'An earlier request with this `Idempotency-Key` is still running.',
    resolution: 'Retry in a few seconds with the same key to receive the original response.',
  },
  VERIFICATION_REQUIRED: {
    status: 403,
    retryable: false,
    category: 'policy',
    meaning: 'The artifact exists but no passing verification report vouches for these bytes, so it cannot be exported.',
    resolution: 'Compile again until verification passes, then download the artifact of that run. This gate is server-side and cannot be bypassed by any role.',
  },
  SPEC_TOO_LARGE: {
    status: 413,
    retryable: false,
    category: 'policy',
    meaning: 'The request body exceeds 1 MB.',
    resolution: 'Send a smaller specification.',
  },
  COMPILE_FAILED: {
    status: 422,
    retryable: false,
    category: 'compilation',
    meaning: 'Compilation failed for a reason the more specific codes below do not cover.',
    resolution: 'Read `message` and `hint`; both name the stage that failed.',
  },
  PARSE_ERROR: {
    status: 422,
    retryable: false,
    category: 'compilation',
    meaning: 'The specification could not be parsed. `details.span` gives the line and column.',
    resolution: 'Fix the syntax at the reported position.',
  },
  UNSUPPORTED_CONSTRUCT: {
    status: 422,
    retryable: false,
    category: 'compilation',
    meaning: 'The specification uses a construct the Python subset does not support. `message` names the construct.',
    resolution: 'Rewrite using the supported subset, which `hint` lists.',
  },
  INVALID_SPEC: {
    status: 422,
    retryable: false,
    category: 'compilation',
    meaning: 'The specification parsed but is not well formed — an undefined variable, a duplicated output, an arity mismatch.',
    resolution: 'Correct the specification as described in `message`.',
  },
  BUDGET_EXCEEDED: {
    status: 422,
    retryable: false,
    category: 'compilation',
    meaning: 'The circuit does not fit the resource budget declared with the request. `details` reports each budget and what the circuit needs.',
    resolution: 'Raise the budget, or simplify the specification. Retrying unchanged will fail identically — the compiler is deterministic.',
  },
  VERIFICATION_FAILED: {
    status: 422,
    retryable: false,
    category: 'compilation',
    meaning: 'A verification check failed. `details` carries the failing check and, for an equivalence failure, a counterexample.',
    resolution: 'Inspect the counterexample. No artifact from this run can be exported.',
  },
  INTERNAL: {
    status: 500,
    retryable: true,
    category: 'server',
    meaning: 'An unexpected failure. No internal detail is disclosed; the stack is logged server-side.',
    resolution: 'Retry shortly. If it persists, report the time of the request.',
  },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

/** The table as the public endpoint and the generated reference both serve it. */
export function errorTable(): Array<ErrorSpec & { code: ErrorCode }> {
  return ERROR_CODES.map((code) => ({ code, ...ERROR_CATALOG[code] }));
}
