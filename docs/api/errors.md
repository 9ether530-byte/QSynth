# Error reference

<!-- Generated from functions/api/src/errorcatalog.ts by `npm run docs:errors`. Do not edit by hand. -->

Every failure returns the same envelope:

```json
{
  "error": {
    "code": "BUDGET_EXCEEDED",
    "message": "What went wrong, in terms of your request.",
    "hint": "What to do about it.",
    "retryable": false,
    "details": { "…": "code-specific, documented below where it matters" }
  }
}
```

Branch on `code`. It is stable; `message` and `hint` are prose and may be reworded.

`retryable` answers one question: *could replaying this exact request succeed later?*
It does not mean the failure was ours. A `429` is retryable, a `401` is not — the same
credential will be refused the same way — and a `422` is not, because the request itself
is what needs to change.

The live table is served at `GET /v1/errors`, so a client library can generate its own
enum and retry policy rather than keeping a copy that ages.

## One exception to the envelope

A `429` whose body is **not** this envelope — no `error.code`, and an
`x-amzn-errortype` header — came from the platform concurrency throttle in front of
the API, before any of our code ran. We cannot dress it up as one of ours. Treat it
exactly like `RATE_LIMITED`: back off and retry. It is the only status a caller can
receive that is not described below.

## Authentication

| Code | HTTP | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `UNAUTHENTICATED` | 401 | no | No credential was presented, or the API key presented is unknown, revoked, or expired. | Send `Authorization: Bearer <session token or API key>`. Issue a new key if the old one was revoked. |
| `INVALID_CREDENTIALS` | 401 | no | The email and password combination was not accepted. | Check the address and password. The response is identical for an unknown address and a wrong password, by design. |
| `SESSION_EXPIRED` | 401 | no | The session token is no longer valid — it expired or was logged out. | Sign in again to obtain a new session token. |

## Authorization

| Code | HTTP | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `FORBIDDEN` | 403 | no | The credential is valid but does not carry the permission this endpoint requires. `details.required` names it. | Ask an owner or admin for a role that includes the permission, or use an API key issued with that scope. |
| `NO_ORG_CONTEXT` | 400 | no | The caller belongs to more than one organization and did not say which one the request acts in. `details.organizations` lists the candidates. | Repeat the request with an `X-Org-Id` header naming one of them. |
| `NOT_A_MEMBER` | 403 | no | The caller is not a member of the organization in `X-Org-Id`. The same answer is given when no such organization exists, so that ids cannot be probed. | Drop the header to use your own organization, or ask for an invitation. |

## Request shape

| Code | HTTP | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | no | The request was malformed: a missing or mistyped field, an unparseable body, or a method the path does not support. | Read `message` — it names the offending field — and correct the request before retrying. |
| `NOT_FOUND` | 404 | no | No such resource in the organization you are acting in. A resource belonging to another tenant is reported the same way. | Check the identifier, and that `X-Org-Id` names the organization that owns it. |
| `CONFLICT` | 409 | no | The request contradicts the current state — for example an email that is already registered. | Read `message`; the resolution is specific to the conflict. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no | A body was sent with a Content-Type other than application/json. | Send `Content-Type: application/json`. |

## Policy

| Code | HTTP | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `RATE_LIMITED` | 429 | yes | Too many requests in the current window. `Retry-After` and `RateLimit-Reset` both give the seconds remaining. | Wait for the window to reset, then retry. Watch `RateLimit-Remaining` on successful responses to avoid reaching this at all. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | no | This `Idempotency-Key` was already used for a request with a different body. | Use a fresh key per distinct request; reuse a key only to retry the identical one. |
| `IDEMPOTENT_REQUEST_IN_PROGRESS` | 409 | yes | An earlier request with this `Idempotency-Key` is still running. | Retry in a few seconds with the same key to receive the original response. |
| `VERIFICATION_REQUIRED` | 403 | no | The artifact exists but no passing verification report vouches for these bytes, so it cannot be exported. | Compile again until verification passes, then download the artifact of that run. This gate is server-side and cannot be bypassed by any role. |
| `SPEC_TOO_LARGE` | 413 | no | The request body exceeds 1 MB. | Send a smaller specification. |

## Compilation

| Code | HTTP | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `COMPILE_FAILED` | 422 | no | Compilation failed for a reason the more specific codes below do not cover. | Read `message` and `hint`; both name the stage that failed. |
| `PARSE_ERROR` | 422 | no | The specification could not be parsed. `details.span` gives the line and column. | Fix the syntax at the reported position. |
| `UNSUPPORTED_CONSTRUCT` | 422 | no | The specification uses a construct the Python subset does not support. `message` names the construct. | Rewrite using the supported subset, which `hint` lists. |
| `INVALID_SPEC` | 422 | no | The specification parsed but is not well formed — an undefined variable, a duplicated output, an arity mismatch. | Correct the specification as described in `message`. |
| `BUDGET_EXCEEDED` | 422 | no | The circuit does not fit the resource budget declared with the request. `details` reports each budget and what the circuit needs. | Raise the budget, or simplify the specification. Retrying unchanged will fail identically — the compiler is deterministic. |
| `VERIFICATION_FAILED` | 422 | no | A verification check failed. `details` carries the failing check and, for an equivalence failure, a counterexample. | Inspect the counterexample. No artifact from this run can be exported. |

## Server

| Code | HTTP | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `INTERNAL` | 500 | yes | An unexpected failure. No internal detail is disclosed; the stack is logged server-side. | Retry shortly. If it persists, report the time of the request. |
