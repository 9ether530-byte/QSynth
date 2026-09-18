# QSYNTH v1 — Specification: Classical→Quantum Translation & Verification

## Context

The master brief defines an enterprise SaaS platform ("QSYNTH") spanning five pillars: a
classical→quantum compiler, automated QEC, hardware-aware transpilation, an AI synthesis
layer, and a collaborative workbench — targeting Kubernetes, Temporal, Kafka, ClickHouse,
Python/Qiskit services, SSO/SCIM, Stripe metering, and SOC 2 readiness.

This project runs on **OpenKBS**, which provides Node.js 24 Lambda functions (~4 MB bundle,
30 s timeout), a static site on S3+CloudFront, managed Postgres, S3 storage, MQTT, email, and
a multi-vendor AI proxy. It does **not** provide Kubernetes, Terraform, Temporal, Kafka,
ClickHouse, a vector DB, a Python runtime, or a multi-region control plane. The brief's
Section 3 stack and the majority of Sections 8–10 are therefore not deliverable as written.

Rather than produce a shallow imitation of all five pillars, v1 delivers **one pillar to
production depth**: the translation engine and its verifier — the part the brief itself calls
"the moat" and protects with Global Constraint #2 ("never emit unverified quantum code").
Everything downstream (QEC, transpilation, AI synthesis, hardware submission, billing) is
specified as later phases so the v1 interfaces are designed to receive them.

**Intended outcome:** a user pastes a Boolean expression, a truth table, or a restricted
Python function, and receives an OpenQASM 3.0 circuit that has *provably* passed a
deterministic verification gate — with a resource estimate, an explained lowering trace, and
a reproducible, content-addressed artifact they can re-run bit-for-bit.

### Decisions taken in this spec (confirmed with the user)

| Decision | Choice |
|---|---|
| v1 scope | Deep vertical: Translate + Verify |
| Compute | Pure TypeScript simulators in Lambda |
| Input surface | Boolean expressions + truth tables + restricted Python subset |

---

## Goals

1. **G1 — Correct lowering.** Translate classical specifications into gate-level quantum
   circuits through an explicit, inspectable IR stack, with automatic uncomputation so that
   emitted circuits are garbage-free by default.
2. **G2 — Verification as a hard gate.** No circuit becomes exportable until it passes a
   deterministic check suite. A failed check yields a counterexample, never a warning.
3. **G3 — Reproducibility.** Identical input + compiler version + seed produces a
   byte-identical artifact, addressed by content hash.
4. **G4 — Explainability.** Every structural decision (ancilla allocation, Toffoli choice,
   uncompute point) is attributable to a specific step in the lowering trace.
5. **G5 — Time to first circuit under five minutes**, from landing on the workbench to a
   verified circuit with a resource estimate.
6. **G6 — Tenant-isolated multi-user foundation** that later phases can build billing,
   collaboration, and hardware approval gates on top of.

**Non-goals for v1:** QEC insertion, hardware-aware transpilation, AI synthesis, real QPU
submission, billing, SSO/SCIM. These are Phase 2+ and are shaped, not built, here.

---

## Personas served in v1

- **Classical Software Engineer** (primary) — knows algorithms, not quantum. Needs the
  translation layer and the explanation of *why* each gate exists.
- **Quantum Developer (IC)** (primary) — wants faster iteration and a trustworthy equivalence
  check before spending attention on a circuit.
- **Research Lead** (secondary) — needs reproducibility and resource estimates.
- **Platform Admin** — deferred to a later phase; v1 provides only the org/role foundation.

---

## Functional Requirements

### FR-1 — Specification input

The system accepts three input kinds and rejects everything else with a typed, located error.

**FR-1.1 Boolean expressions.** Named inputs, the operators `AND OR XOR NOT NAND NOR XNOR`,
parentheses, and one or more named outputs. Multi-output expressions share a single circuit.

**FR-1.2 Truth tables.** An explicit input/output table over ≤ 12 input variables. Rows may be
partial; unspecified rows are treated as don't-care and this is reported to the user.

**FR-1.3 Restricted Python subset.** A single pure function whose parameters and return are
`bool` or bounded-width `int`. Supported: boolean and bitwise operators, comparisons, integer
arithmetic within declared widths, `if`/`else`, `return`, and `for` loops over literal ranges
(fully unrolled). Rejected with an explanatory message: I/O, imports, recursion, unbounded
loops, mutation of captured state, floats, strings, and any call to a non-whitelisted builtin.

**FR-1.4 Declared budgets.** The user may attach a budget to any spec — maximum qubits,
maximum circuit depth, maximum T-count. Exceeding a declared budget fails verification
(FR-4.5), it does not merely warn.

### FR-2 — IR stack

Compilation proceeds through four named, independently inspectable layers. Each layer is a
retained artifact, not a transient in-memory value.

1. **Classical IR** — typed SSA dataflow graph over bit and bounded-int values.
2. **Reversible IR** — Bennett-style embedding over `NOT`, `CNOT`, `Toffoli`, `Fredkin`, with
   an explicit **ancilla ledger** recording every ancilla's allocation point, purpose,
   uncompute point, and release point.
3. **Quantum IR** — gate-level with parameterized rotations, plus Clifford+T decomposition of
   any multi-controlled gate.
4. **Target IR** — OpenQASM 3.0 as the v1 export target.

The user can view any layer for any compile job, and the workbench shows how each layer maps
onto the next.

### FR-3 — Optimization passes

The following run by default and are individually reportable (gates removed / added per pass):
constant folding, dead-code elimination, CNOT cancellation, gate fusion, ancilla reuse, and
automatic uncomputation. Each pass must be **verification-preserving**: the post-pass circuit
is checked against the pre-pass circuit, and a pass whose output fails equivalence is dropped
with the unoptimized circuit retained and the event surfaced to the user.

An optimization level (0 = none, 1 = default, 2 = aggressive) is selectable per compile.

### FR-4 — Verification gate

Every compile runs these checks **in order**, and produces a machine-readable
`VerificationReport` (JSON) plus a human summary. Ordering matters: a failure short-circuits
the remaining checks and reports which were not reached.

1. **Type/shape check** — qubit counts, register widths, parameter arity.
2. **Simulation equivalence** — for ≤ 12 input bits, exhaustive over all input assignments;
   above that, randomized sampling with the sample count and RNG seed recorded in the report.
   Clifford-only circuits use the stabilizer simulator; the rest use statevector.
3. **Reversibility check** — `U · U† = I` within a stated numerical tolerance.
4. **Garbage-free assertion** — every allocated ancilla returns to |0⟩ at circuit end. Reported
   per-ancilla against the ledger from FR-2.
5. **Property checks** — user-declared invariants evaluated over the simulated circuit.
6. **Resource assertions** — fails when a declared FR-1.4 budget is exceeded.

**The gate is hard.** A circuit whose report contains any failure cannot be exported,
downloaded, or shared via permalink. The export path checks the stored report, not a
client-supplied flag. Failures carry a **counterexample**: the concrete input assignment, the
expected classical output, and the observed quantum output.

### FR-5 — Resource estimation

Every successful compile reports: logical qubit count, ancilla count, circuit depth, total
gate count, two-qubit gate count, T-count, and T-depth. Estimates are deterministic and
recomputed from the artifact, never cached independently of it.

### FR-6 — Explainability trace

Each compile produces a **lowering trace**: an ordered list of decisions, each naming the
source construct, the action taken, and the reason — e.g. *"`a AND b` is irreversible;
allocated ancilla q4 to hold the result; uncomputed at step 31."* The workbench links every
gate in the circuit diagram back to its originating trace entry and source span, in both
directions.

### FR-7 — Artifacts, versioning, reproducibility

- Every artifact (classical IR, reversible IR, quantum IR, QASM, verification report,
  resource estimate) is stored with a **SHA-256 content hash of its canonical bytes**.
  Identical content deduplicates.
- Every compile records the compiler version and the RNG seed. **Re-running a job with the
  same input, compiler version, and seed must produce identical content hashes** — this is
  itself an automated test, not just a claim.
- Compile jobs are **append-only**: state transitions are recorded, never overwritten.
- Circuit versions form a parent/child chain, enabling diffs (FR-9.3).

### FR-8 — Multi-tenancy, identity, audit

- **Organizations** own all data. Every tenant-scoped table carries `org_id` and isolation is
  enforced in the data layer, not only in handlers.
- **Roles:** owner, admin, developer, viewer. Deny-by-default: a permission absent from the
  role matrix is denied.
- **Authentication:** email + password with hashed credentials and session tokens.
  *SSO/SAML/OIDC/SCIM and MFA are out of scope for v1* (see Constraints).
- **API keys** — org-scoped, hashed at rest, with scopes and revocation, for programmatic
  compiles.
- **Audit log** — append-only record of every state-changing privileged action (project
  create/delete, member role change, key issue/revoke, export of a verified circuit),
  capturing actor, action, resource, IP, user agent, timestamp.
- **Cross-tenant access attempts must return 404/403 and are covered by explicit tests.**

### FR-9 — Web workbench

**FR-9.1 Layout.** Left: spec editor with syntax highlighting and inline error markers.
Center: circuit diagram. Right: inspector (resources, verification status, ancilla ledger).
Bottom: results console with the lowering trace.

**FR-9.2 Compile flow.** Submit → per-stage progress (parse → classical IR → reversible IR →
quantum IR → optimize → verify → emit) → result. Each stage reports independently so a failure
is attributable to a stage, never to a generic "compile failed".

**FR-9.3 Diff view.** Side-by-side comparison of two circuit versions: gate-level diff plus
resource delta.

**FR-9.4 States.** Every surface defines empty, loading (skeletons, not spinners), error, and
partial-failure states.

**FR-9.5 Accessibility.** WCAG 2.2 AA: full keyboard navigation, screen-reader labels on the
circuit diagram and all visualizations, colorblind-safe palette, visible focus states. The
circuit diagram has a **text-equivalent gate list** — a canvas alone is not accessible.

**FR-9.6 Dark mode**, desktop-first down to 1280 px; read-only below that.

### FR-10 — Public API

REST endpoints covering: compile submit, compile status, compile stream (progress),
re-verify, artifact fetch, resource estimate (fast path, no full verification), and CRUD for
projects, members, and API keys. Requirements:

- Deny-by-default authorization; every endpoint declares its required scope.
- `Idempotency-Key` honored on every state-mutating POST.
- Per-org and per-key rate limits, returning 429 with `Retry-After`.
- Typed errors: every failure carries a stable machine-readable code, a human message, and a
  fix hint. **No silent failures** (Global Constraint #3).

---

## User Stories

- **US-1.** As a classical engineer, I paste a Python function and receive a verified circuit
  with a resource estimate in under five minutes, without knowing what a Toffoli gate is.
- **US-2.** As a quantum developer, I see exactly which verification checks passed, and for
  any failure I get the concrete input assignment that breaks the circuit.
- **US-3.** As a quantum developer, I hover any gate and learn which source construct produced
  it and why.
- **US-4.** As a research lead, I re-run a six-month-old job and get byte-identical artifacts.
- **US-5.** As a research lead, I diff two circuit versions and see the resource delta.
- **US-6.** As a developer, I declare a 20-qubit budget and the compile *fails* when the
  lowering exceeds it, rather than silently producing something I cannot run.
- **US-7.** As an org owner, I invite a colleague as a viewer and confirm they cannot modify
  projects or issue API keys.
- **US-8.** As an org owner, I review the audit log and see every export and role change.
- **US-9.** As a developer, I compile via the public API with a scoped key in CI.
- **US-10.** As a user, when my Python input uses an unsupported construct, the error names
  the construct, points at the line, and tells me what is supported instead.

---

## Acceptance Criteria

**Correctness**
- [ ] For every Boolean spec with ≤ 12 inputs, the emitted circuit matches the classical truth
      table on **all** input assignments.
- [ ] Every emitted circuit is garbage-free: all ancillas verified returning to |0⟩.
- [ ] `U · U†= I` holds within the stated tolerance for all emitted permutation circuits.
- [ ] A curated golden corpus (adder, comparator, multiplexer, parity, majority, Grover
      oracle) has snapshotted QASM + resource estimates; changing a snapshot requires review.
- [ ] Property-based testing: randomly generated Boolean specs compile and verify, or fail
      with a counterexample that reproduces.

**Verification gate**
- [ ] A circuit with a failing report cannot be exported via UI or API — proven by a test that
      attempts the export and asserts rejection.
- [ ] Each of the six checks has a test that makes it fail deliberately and asserts the
      correct check is reported, with a valid counterexample where applicable.

**Reproducibility**
- [ ] An automated test compiles the corpus twice and asserts identical content hashes.

**Tenancy & security**
- [ ] A tenant-isolation suite attempts cross-org reads on every tenant-scoped resource and
      asserts 403/404. This suite runs on every change.
- [ ] An authorization matrix test covers every role × every endpoint.
- [ ] Parser fuzzing: no input crashes the service or produces an untyped error.

**Performance & UX**
- [ ] A ≤ 12-input Boolean spec compiles and fully verifies within the function timeout;
      specs that cannot are rejected up front with a clear explanation, never timed out.
- [ ] Onboarding path (land → paste example → verified circuit) completes in under 5 minutes.
- [ ] Automated accessibility checks pass on every route.

**Observability**
- [ ] Every compile emits structured logs with a job correlation id; every failure is typed,
      logged, and surfaced to the user with a fix hint.

---

## Constraints & Assumptions

**Platform constraints (hard)**
1. Node.js 24 Lambda only — **no Python runtime**. Qiskit, Cirq, Stim, PyMatching, and `ldpc`
   are unavailable. The statevector and stabilizer simulators are implemented in TypeScript.
2. ~4 MB deployment bundle and a 30 s function timeout bound per-request work. Specs whose
   verification cannot complete within the budget are **rejected at submission with an
   explanation**, not accepted and timed out.
3. No Kubernetes, Terraform, ArgoCD, Temporal, Kafka, ClickHouse, or vector DB. Deployment is
   `openkbs deploy` + `fn deploy` + `site deploy`. Multi-region is not available.
4. Postgres is the single datastore; S3 holds artifact blobs.

**Engineering limits accepted**
5. Statevector simulation is capped at **20 qubits** (~16 M complex amplitudes). The stabilizer
   simulator handles larger Clifford-only circuits. Above both limits, equivalence is
   randomized-sampled, and the report states so explicitly rather than implying exhaustiveness.
6. Verification is **empirical, not formal**. No theorem proving. The report states its method
   and confidence; "verified" never over-claims.
7. Truth tables are capped at 12 input variables; Python loops must be statically bounded.

**Assumptions stated (per brief §15 — redirect if wrong)**
8. Authentication is email + password. SSO/SAML/OIDC, SCIM, and MFA are deferred — no IdP is
   configured and OpenKBS provides no SSO primitive.
9. Data residency is a single region (`us-east-1`, per `openkbs.json`).
10. Postgres must be enabled on the project (`"postgres": true`); it is currently `false`.
11. Interactive per-stage progress uses polling or MQTT rather than long-lived SSE, since
    Lambda does not stream responses.

---

## Out of Scope for v1 (with rationale)

| Excluded | Why |
|---|---|
| **Pillar B — QEC engine** (surface/Steane/Shor codes, MWPM & BP+OSD decoders, LER curves, threshold analysis) | Depends on a Stim-class stabilizer simulator at scale and a matching decoder. Deferred to Phase 3; FR-2's Quantum IR is the designated insertion point. |
| **Pillar C — Hardware-aware transpilation** (SABRE routing, native gate sets, pulse hooks, backend registry) | Requires live vendor calibration feeds and credentials. Phase 2; the Target IR layer is where it attaches. |
| **Pillar D — AI synthesis layer** (RAG corpus, LLM orchestration, repair loop, RL optimizer) | Global Constraint #2 requires the compiler and verifier to exist *first* as the guardrail. The AI proxy is available; Phase 4. |
| **Real QPU submission** (IBM, IonQ, Rigetti, Quantinuum, Braket, Azure) | Needs vendor accounts, credentials, and budget controls. Phase 5. |
| **Stripe billing, metering, quotas, usage dashboards** | No revenue path until there is something to meter beyond compiles. Phase 5. |
| **SSO/SAML/OIDC, SCIM, MFA** | No IdP integration available on the platform. Phase 6. |
| **SOC 2 evidence automation, ISO 27001, DSAR endpoints, data residency tiers, dedicated tenancy** | Compliance programs are organizational, not merely code; the platform cannot supply multi-region or dedicated infrastructure. Phase 6. |
| **Kubernetes/Terraform/ArgoCD/Temporal/Kafka/ClickHouse infrastructure** | Not available on OpenKBS. Permanently out of scope for this deployment target. |
| **Load testing at 1k concurrent, chaos testing, DR drills, status page, on-call rotation** | Presuppose infrastructure this platform does not expose. |
| **Team collaboration: comments, review/approval gates, git-backed storage** | Approval gates exist to guard hardware submission, which is out of scope. Phase 5. |
| **Cirq / Braket IR / QIR LLVM export** | OpenQASM 3.0 is the v1 target; additional emitters are additive once the Quantum IR is stable. |
| **Mobile UI** | Desktop-first; read-only below 1280 px. |

---

## Phasing after v1

- **Phase 2** — Transpilation & backend registry (attaches at Target IR).
- **Phase 3** — QEC engine (attaches at Quantum IR); likely requires the EC2 worker tier for
  decoder performance.
- **Phase 4** — AI synthesis layer behind the v1 verification gate.
- **Phase 5** — Hardware adapters, approval gates, metering, billing.
- **Phase 6** — Enterprise hardening (SSO, residency, compliance) — gated on platform
  capabilities that do not exist today.

---

## Verification of this specification

The spec is satisfied when, end to end:

1. **Compile a Boolean spec.** Submit `out = (a AND b) XOR c` via the workbench. Inspect all
   four IR layers, confirm the ancilla ledger shows allocation and uncompute, and confirm the
   verification report shows all six checks passing with exhaustive (8/8) equivalence coverage.
2. **Compile a Python function.** Paste a 4-bit ripple-carry adder. Confirm the emitted QASM
   parses, verification passes, and resource estimates are reported.
3. **Force each failure.** Inject a deliberate bug per check (mismatched arity, wrong gate,
   leaked ancilla, violated invariant, exceeded budget) and confirm the correct check fails
   with a reproducing counterexample, and that export is blocked in UI and API alike.
4. **Reproduce.** Re-run every corpus job and assert identical content hashes.
5. **Isolate.** Run the tenant-isolation and authorization-matrix suites; confirm every
   cross-org attempt is refused.
6. **Diff.** Modify a spec, recompile, and confirm the diff view shows both the gate-level
   change and the resource delta.
7. **Access.** Run automated accessibility checks on every route and confirm the circuit
   diagram exposes a text-equivalent gate list to a screen reader.
