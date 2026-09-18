# QSYNTH v1 — Implementation Plan

Implements `spec/qsynth-v1-specification-classical-quantum-translation-verifi.md`.

## Context

The repo is the bare OpenKBS template: one demo `api` Lambda with action-dispatch, one
gradient placeholder page, `postgres: false`. Everything in the spec is new construction.

The plan's central engineering decision — the one that makes a hard verification gate
affordable inside a 30 s Node Lambda — is **verifying at the Reversible IR layer using
basis-state simulation, not statevector simulation.**

A reversible circuit over `NOT`/`CNOT`/`Toffoli`/`Fredkin` maps each computational basis state
to exactly one other basis state. Checking it against a classical spec therefore costs
`O(2^inputs × gates)` bit operations — for 12 inputs and a few thousand gates that is single-
digit milliseconds, and it is *exhaustive*, not sampled. A statevector approach would cost
`2^qubits` complex amplitudes per run and would cap us far lower.

Statevector and stabilizer simulation are still built (the spec requires them), but they carry
a narrower load: proving that the **Clifford+T decomposition rules** are correct. Each rule
(e.g. Toffoli → 2·H, 6·CNOT, 7·T) is a fixed small unitary verified once against its 8×8
matrix in unit tests, plus sampled end-to-end statevector equivalence on ≤ 20-qubit circuits.
Correctness composes: exhaustive at the reversible layer + per-rule exactness at the quantum
layer ⇒ end-to-end correctness, without ever building a 2²⁰ vector on the request path.

---

## Architecture

```
packages/qsynth-core/     TypeScript compiler + simulators. Zero runtime deps. Vitest.
functions/api/            REST Lambda. index.mjs is esbuild output (committed).
functions/migrate/        Forward-only SQL migration runner, run via `openkbs fn invoke`.
site/index.html           Plain HTML landing page (SEO, no framework).
site/app/                 React+Vite+Tailwind workbench SPA, BrowserRouter basename="/app".
migrations/*.sql          Numbered, forward-only.
```

**Why a bundled Lambda:** the core is TypeScript, Lambda runs ESM JS. `esbuild` bundles
`functions/api/src/handler.ts` + the core into a single `functions/api/index.mjs`, committed so
deploys are reproducible. `pg` stays external and is installed into
`functions/api/node_modules`. Bundle lands well under the 4 MB cap (core is dependency-free;
`pg` ≈ 1 MB).

**Config changes** in `openkbs.json`: `"postgres": true`, api `timeout: 60` (headroom over the
compile budget), `"spa": "/app/index.html"`.

---

## Data model

`migrations/001_init.sql` — every tenant table carries `org_id uuid not null`.

| Table | Purpose |
|---|---|
| `organizations`, `users`, `memberships(role)`, `sessions` | Identity. Roles: owner/admin/developer/viewer. |
| `api_keys(hashed_key, scopes[], revoked_at)` | Programmatic access. SHA-256 at rest. |
| `projects`, `specs(kind, source, budgets_json)` | User content. `kind` ∈ boolean/truthtable/python. |
| `compile_jobs(status, seed, compiler_version, spec_hash)` | Append-only via `compile_job_events`. |
| `compile_stages(job_id, stage, status, duration_ms, error_code)` | Per-stage attribution (FR-9.2). |
| `artifacts(content_hash, kind, storage_uri, size_bytes)` | Unique on `(org_id, content_hash)` → dedup. Bytes in S3 at `artifacts/<hash>`. |
| `circuit_versions(parent_version_id, …)` | Version chain for diffs. |
| `verification_reports(job_id, passed, checks_json)` | **Export authority.** Read server-side, never trusted from client. |
| `resource_estimates` | Qubits, depth, gate/2q/T counts, T-depth. |
| `audit_logs` | Append-only; no UPDATE/DELETE grant. |
| `idempotency_keys(org_id, key, response_json)` | Replay POSTs. |
| `rate_limit_buckets(org_id, subject, window_start, count)` | Postgres token bucket (no Redis on platform). |

**RLS is real, not app-level.** Every tenant table gets `ENABLE` + **`FORCE ROW LEVEL
SECURITY`** (without `FORCE`, the table owner — which is our connection role — silently
bypasses policies). Policies read `current_setting('app.current_org', true)::uuid`. Every
request runs inside a transaction opened with `SET LOCAL app.current_org = $1`. A helper
`withOrgTx(orgId, fn)` in `functions/api/src/db.ts` is the *only* sanctioned query path; a
lint rule and a code-review note forbid raw `pool.query` on tenant tables.

---

## packages/qsynth-core

Build order matters — each layer is testable before the next exists.

**1. Foundations** — `errors.ts` (typed `QsynthError` with stable `code`, `message`, `hint`,
source span; every thrown error in the system is one of these — Global Constraint #3),
`hash.ts` (canonical JSON serialization → SHA-256; key-sorted, no floats-as-text ambiguity —
this is what makes FR-7 reproducibility testable).

**2. Frontends** → Classical IR
- `frontend/boolean/{lexer,parser,lower}.ts` — precedence-climbing parser, multi-output.
- `frontend/truthtable/*` — ≤ 12 vars, don't-care rows reported not silently filled.
- `frontend/python/*` — hand-written tokenizer + recursive-descent parser over the restricted
  subset. **Whitelist, not blacklist:** any node type not explicitly supported raises
  `UNSUPPORTED_CONSTRUCT` naming the construct, its line, and what *is* supported (US-10).
  `for` over literal ranges is unrolled at parse time.

**3. `ir/classical.ts`** — typed SSA dataflow graph, bit and bounded-int values.

**4. `lowering/classicalToReversible.ts`** — the heart. Bennett-style embedding; allocates
ancillas through an **`AncillaLedger`** (`ir/reversible.ts`) that records allocation point,
purpose, uncompute point, release point. Compute → copy-out → uncompute in reverse, so
garbage-freedom is structural rather than a later repair. Every allocation and uncompute
appends a `TraceEntry` (`trace/trace.ts`) carrying source span + human reason — this *is*
FR-6, produced during lowering, never reconstructed after.

**5. `sim/basisState.ts`** — evolves one basis state through reversible gates. The workhorse.

**6. `verify/checks.ts`** — the six checks, short-circuiting, each returning structured
evidence. Equivalence is exhaustive at ≤ 12 inputs, else randomized with sample count + seed
recorded. Failures carry a counterexample `{inputs, expected, observed}`. `verify/report.ts`
defines `VerificationReport` with `checksReached` so a short-circuit reports what it skipped.

**7. `emit/qasm3.ts`** + `estimate/resources.ts` — deterministic, recomputed from the artifact.

**8. `ir/quantum.ts`** + `lowering/reversibleToQuantum.ts` — Clifford+T decomposition rules as
a table of `{pattern, replacement, verifiedUnitary}`.

**9. `sim/statevector.ts`** (≤ 20 qubits, flat `Float64Array` re/im pairs) and
`sim/stabilizer.ts` (CHP tableau for Clifford-only) — used by rule verification and sampled
end-to-end checks.

**10. `passes/`** — each pass is `(circuit) => circuit`. `passes/runner.ts` wraps every pass in
an **equivalence guard**: run the pass, basis-state-check output against input, and on
mismatch discard the pass, keep the unoptimized circuit, and record it in the report (FR-3).
A buggy optimizer can therefore cost performance but never correctness.

---

## functions/api

`src/handler.ts` → `index.mjs`. Real REST routing on
`event.requestContext.http.{method,path}`, tolerating both `/v1/...` (direct Lambda URL) and
`/api/v1/...` (via CloudFront).

| Route | Notes |
|---|---|
| `POST /v1/auth/{register,login,logout}` | scrypt from `node:crypto` — no dependency. HMAC session tokens + `sessions` row. |
| `POST /v1/compile` | Synchronous. Pre-flight complexity check rejects specs projected to exceed the budget **before** accepting (spec constraint 2) — never accept-then-timeout. |
| `GET /v1/compile/{id}` | Job + stages + report + estimate. |
| `POST /v1/compile/{id}/verify` | Re-verify from stored artifacts. |
| `POST /v1/compile/estimate` | Fast path: lower + estimate, skip verification. |
| `GET /v1/artifacts/{id}` | **Export gate lives here:** loads the stored `verification_reports.passed` for the owning job; refuses non-verified artifacts regardless of caller. |
| `CRUD /v1/{projects,members,api-keys}`, `GET /v1/audit-logs` | Role-gated. |

Cross-cutting middleware in `src/middleware/`: auth (session or API key) → role/scope check
(**deny-by-default: routes declare required scope; a route with no declaration is refused, not
allowed**) → rate limit (429 + `Retry-After`) → idempotency (replay stored response on repeat
`Idempotency-Key`) → `withOrgTx` → audit emit.

**Progress reporting without SSE:** Lambda cannot stream. Compile is synchronous and fast, so
the response carries the full `stages[]` array with per-stage timings and the UI animates
through them. Honest per-stage attribution, no MQTT dependency, no fake progress bar.

---

## site/app — workbench

React 18 + Vite + Tailwind + TanStack Query + Zustand, `BrowserRouter basename="/app"`, built
to `site/app/` with Vite `base: '/app/'`.

**Aesthetic — "laboratory instrument".** Dark-first, near-black `#0B0D10` ground, precise 8 px
grid, hairline rules instead of card shadows. Type: **Space Grotesk** display + **IBM Plex
Mono** for all code, IR, and gate labels. Accents: cyan `#22D3EE` (verified), amber `#F59E0B`
(warning/unoptimized), red-orange `#FB7185` (failed) — chosen to stay distinguishable under
deuteranopia and protanopia; **status is never encoded by color alone** — every state carries
an icon and a text label. No gradients, no rounded-2xl card grids, no glassmorphism.

Panels per FR-9.1: left spec editor (CodeMirror 6 — far lighter than Monaco, matters for a
CDN-served bundle) with inline error markers from `QsynthError` spans; center circuit diagram;
right inspector (resources, per-check verification status, ancilla ledger); bottom trace
console.

**The circuit diagram is SVG, not canvas.** This is an accessibility decision as much as a
rendering one: SVG gives real DOM nodes to focus, label, and hover-link to trace entries and
source spans bidirectionally, and it lets the required text-equivalent gate list (FR-9.5) be
the same data rather than a parallel implementation. Canvas would need all of that rebuilt.

Routes: `/app` projects · `/app/p/:id` workbench · `/app/p/:id/diff/:a/:b` diff ·
`/app/settings/{members,keys,audit}`.

`site/index.html` is rewritten as a real landing page (plain HTML, no framework, SEO-friendly)
replacing the template placeholder.

**API base:** starts as `/api`; after the first `openkbs fn deploy api` prints the direct
function URL, `site/app/src/lib/api.ts` is updated to it and the site redeployed (saves
~30–50 ms/request per the platform guidance).

---

## Testing

| Layer | Location / tool | Covers |
|---|---|---|
| Unit | `packages/qsynth-core/test/` (vitest) | Parsers, lowering, ledger, each pass, each check, decomposition rules vs. exact unitaries. |
| Golden | `test/golden/*.qasm` snapshots | Adder, comparator, multiplexer, parity, majority, Grover oracle. Snapshot change requires review. |
| Property | `fast-check` (dev dep) | Random Boolean specs → compile → exhaustive equivalence, or a counterexample that reproduces. |
| Reproducibility | `test/reproducibility.test.ts` | Compile corpus twice, assert identical content hashes (FR-7 as a test, not a claim). |
| Fuzz | `test/fuzz/` | Random/malformed input into all three parsers: no crash, no untyped error. |
| Integration | `test/integration/` against `DATABASE_URL` from `openkbs postgres connection` | **Tenant isolation** (cross-org read on every resource → 403/404), **authz matrix** (every role × every endpoint), export-gate refusal, idempotency replay. |
| A11y | `axe-core` in the SPA test run | Every route. |

Deliberate-failure tests are mandatory per check: inject mismatched arity, a wrong gate, a
leaked ancilla, a violated invariant, and an exceeded budget; assert the *correct* check fails
with a valid counterexample and that export is refused via **both** UI and API paths.

---

## Build order

Each step ends in something runnable; nothing is a horizontal layer.

1. **Tooling + config** — root workspace, tsconfig, vitest, esbuild script; `openkbs.json`
   (postgres on, timeout 60, spa).
2. **Schema + migrate function** — `001_init.sql` with RLS/FORCE; `openkbs deploy` then
   `openkbs fn invoke migrate`.
3. **Identity slice** — register/login/sessions/orgs/roles/audit + **tenant-isolation and
   authz-matrix tests passing**. Nothing else starts until isolation is proven.
4. **Boolean → Reversible → verified QASM** — frontends 1+2, Classical IR, Bennett lowering +
   ledger + trace, basis-state sim, checks 1–4 & 6, QASM emit, estimates, `POST /v1/compile`.
   *First verified circuit exists here.*
5. **Quantum IR** — Clifford+T rules with per-rule unitary verification; statevector +
   stabilizer sims; sampled end-to-end check.
6. **Optimization passes** behind the equivalence guard.
7. **Python subset frontend.**
8. **Workbench UI** — editor, SVG diagram, inspector, trace, diff view, a11y pass.
9. **Public API hardening** — API keys, scopes, rate limits, idempotency, error-code table.
10. **Landing page**, docs, golden-corpus freeze.

---

## Verification

**Automated** (`npm test` at root, plus `npm run test:integration` with a live `DATABASE_URL`):
unit + golden + property + reproducibility + fuzz + isolation + authz + a11y, per the table
above.

**Manual end-to-end**, after `openkbs deploy && openkbs fn deploy api && openkbs fn deploy
migrate && openkbs site deploy`:

1. Register, create a project, paste `out = (a AND b) XOR c`. Inspect all four IR layers;
   confirm the ancilla ledger shows allocation *and* uncompute; confirm the report shows six
   checks passing with **8/8 exhaustive** coverage.
2. Paste a 4-bit ripple-carry adder in the Python subset. Confirm the emitted QASM parses,
   verification passes, estimates are reported.
3. Declare a 4-qubit budget on a spec needing more → confirm the compile **fails** on check 6
   and the artifact cannot be downloaded.
4. `curl` the artifact endpoint directly for that failed job → confirm refusal (proves the gate
   is server-side, not UI-side).
5. Recompile a modified spec; confirm the diff shows gate-level change *and* resource delta.
6. Re-run a job; confirm identical content hashes.
7. Invite a viewer; confirm they cannot issue API keys or modify projects.
8. Keyboard-only pass over the workbench; confirm the circuit diagram exposes a text-
   equivalent gate list to a screen reader.

Browser checks 1–8 are driven with `agent-browser` against the deployed site.

---

## Risks

| Risk | Mitigation |
|---|---|
| Python subset scope creep — users expect real Python | Whitelist parser; `UNSUPPORTED_CONSTRUCT` names the construct and lists what's supported. Documented limits on the editor panel itself. |
| 30→60 s timeout still insufficient for worst-case specs | Pre-flight complexity estimate rejects at submission with an explanation. The async job tier is the Phase-2 escape hatch (spec Phase 3 notes EC2 workers). |
| RLS misconfiguration silently disables isolation | `FORCE ROW LEVEL SECURITY` + an integration test that asserts cross-org reads fail *as the application role*, not as a superuser. |
| Lambda bundle growth past 4 MB | Core is dependency-free; `pg` is the only runtime dep; CodeMirror over Monaco on the frontend. Bundle size asserted in the build script. |
| Clifford+T decomposition subtly wrong | Each rule verified once against its exact unitary in unit tests, plus sampled end-to-end statevector equivalence. |
