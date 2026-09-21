# Endpoint reference

<!-- Generated from the route table by `npm run docs:endpoints`. Do not edit by hand. -->

Base URL: the API Function URL, or `/api` on the site distribution — both serve the
same routes, so `/v1/compile` and `/api/v1/compile` are the same endpoint.

## Authenticating

Send `Authorization: Bearer <token>`, where the token is either a session token from
`POST /v1/auth/login` or an API key secret. A session token that belongs to more than
one organization must also send `X-Org-Id`; without it the request is refused with
`NO_ORG_CONTEXT` rather than guessed at.

An API key carries explicit scopes instead of a role. Its permissions are exactly the
scopes it was issued with — it cannot exceed them no matter who created it, and it is
unaffected by later changes to that person's role.

## Reading the columns

- **Reach** — the lowest role that can call it. `developer+` means developer, admin and
  owner; a viewer is refused with `FORBIDDEN`.
- **Scope** — the permission an API key must hold. The same string as the role
  permission, so a key is granted precisely what a role would allow.
- **Idem.** — honours `Idempotency-Key`. Replaying a key returns the stored response
  with `Idempotency-Replayed: true` instead of doing the work twice.

Every authenticated response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`. The default budget is 120 requests/minute per principal; routes marked
`compile` below are metered separately at 20/minute, because they cost real compute.

Routes marked `n/a` are public: there is no principal to meter, so they send no
RateLimit headers. They are not unlimited — `register` is throttled per client IP and
`login` per account *and* per client IP, so guessing one password many times and one
password against many accounts are both expensive. Both answer `429 RATE_LIMITED`.

Failures use one envelope, documented in [errors.md](./errors.md).

## Service

| Endpoint | Reach | Scope | Limit | Idem. | Description |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/health` | anyone | — | n/a | — | Report that the API is reachable, and which compiler version it is running. |
| `GET /v1/errors` | anyone | — | n/a | — | Return the full error-code table this build can answer with. |

## Authentication

| Endpoint | Reach | Scope | Limit | Idem. | Description |
| --- | --- | --- | --- | --- | --- |
| `POST /v1/auth/register` | anyone | — | n/a | — | Create an account and its first organization, and return a session token. |
| `POST /v1/auth/login` | anyone | — | n/a | — | Exchange an email and password for a session token. |
| `POST /v1/auth/logout` | any member | — | default | — | Revoke the session token used to make this request. |
| `GET /v1/auth/me` | any member | — | default | — | Describe the calling principal: a user with their organizations and roles, or an API key's scopes. |

## Projects

| Endpoint | Reach | Scope | Limit | Idem. | Description |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/projects` | viewer+ | `project:read` | default | — | List the projects in the organization. |
| `POST /v1/projects` | developer+ | `project:write` | default | yes | Create a project to hold specifications and their compile history. |
| `GET /v1/projects/:id` | viewer+ | `project:read` | default | — | Fetch one project: its name, description, owner and archived state. |
| `PATCH /v1/projects/:id` | developer+ | `project:write` | default | — | Rename a project, change its description, or archive and unarchive it. |
| `DELETE /v1/projects/:id` | admin+ | `project:delete` | default | — | Delete a project and everything compiled under it. |

## Compilation

| Endpoint | Reach | Scope | Limit | Idem. | Description |
| --- | --- | --- | --- | --- | --- |
| `POST /v1/compile` | developer+ | `compile:run` | compile | yes | Compile a specification, verify the result, and return the circuit with its report. |
| `POST /v1/compile/estimate` | developer+ | `compile:run` | compile | — | Lower a specification and return its resource cost without verifying it. |
| `GET /v1/compile` | viewer+ | `compile:read` | default | — | List compile jobs in the organization, newest first. |
| `GET /v1/compile/:id` | viewer+ | `compile:read` | default | — | Fetch one compile job with its stages, verification report, and resource estimate. |
| `POST /v1/compile/:id/verify` | developer+ | `compile:run` | compile | — | Re-run verification against the stored artifacts of an existing job. |

## Artifacts

| Endpoint | Reach | Scope | Limit | Idem. | Description |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/artifacts/:id` | viewer+ | `artifact:read` | default | — | Download an artifact's bytes. Refused unless a passing report vouches for them. |

## Organization and members

| Endpoint | Reach | Scope | Limit | Idem. | Description |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/organization` | viewer+ | `member:read` | default | — | Fetch the calling organization's name and settings. |
| `PATCH /v1/organization` | owner+ | `org:write` | default | — | Change the organization's name or settings. |
| `GET /v1/members` | viewer+ | `member:read` | default | — | List the organization's members and their roles. |
| `POST /v1/members` | admin+ | `member:write` | default | — | Add an existing user to the organization with a role. |
| `PATCH /v1/members/:userId` | admin+ | `member:write` | default | — | Change a member's role. |
| `DELETE /v1/members/:userId` | admin+ | `member:write` | default | — | Remove a member from the organization. |

## API keys

| Endpoint | Reach | Scope | Limit | Idem. | Description |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/api-keys` | admin+ | `apikey:read` | default | — | List the organization's API keys. Secrets are never returned again after creation. |
| `POST /v1/api-keys` | admin+ | `apikey:write` | default | — | Issue an API key with a set of scopes. The secret is shown once, in this response. |
| `DELETE /v1/api-keys/:id` | admin+ | `apikey:write` | default | — | Revoke an API key immediately. |

## Audit

| Endpoint | Reach | Scope | Limit | Idem. | Description |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/audit-logs` | admin+ | `audit:read` | default | — | Read the organization's audit trail, newest first. |

## The export gate

`GET /v1/artifacts/:id` is the one endpoint whose refusal is not about the caller.
Before returning bytes it looks up the stored verification report for those exact
bytes; with no passing report it answers `403 VERIFICATION_REQUIRED`. An owner with a
valid key gets the same refusal as everyone else, because the check is on the artifact.
