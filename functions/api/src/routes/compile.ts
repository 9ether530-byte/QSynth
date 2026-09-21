/**
 * Compilation, verification and the export gate.
 *
 * Three decisions in this file are load-bearing, and all three are about refusing things.
 *
 * **Refuse before accepting.** A specification whose verification is projected to exceed
 * the request budget is rejected at `preflight`, before any work is done and before the
 * caller is told anything that sounds like progress. The alternative — accept, run, time
 * out — produces a 30-second wait and a message the user cannot act on. The refusal
 * carries the projected figures and the ceiling, so it can be acted on immediately.
 *
 * **A failed verification is an HTTP failure, not a successful response with a flag.**
 * Returning 201 with `passed: false` would mean `curl -f` and `if (res.ok)` treat an
 * unverified circuit as a delivered one — precisely the mistake this product exists to
 * prevent. The job is still persisted in full, so the report, the failing check and its
 * counterexample remain retrievable from `GET /v1/compile/{id}`.
 *
 * **The export gate reads the database, never the request.** `GET /v1/artifacts/{id}`
 * resolves the artifact to the compile jobs that produced it and refuses unless one of
 * them carries a stored verification report with `passed = true`. No header, parameter
 * or client claim can reach that decision, which is what makes the gate a property of
 * the system rather than of the user interface.
 */
import {
  BUDGET_FIELDS,
  COMPILER_VERSION,
  MAX_SOURCE_BYTES,
  SPEC_KINDS,
  TraceRecorder,
  compile,
  contentHash,
  estimateOnly,
  parseSpec,
  preflight,
  rebuild,
  seedFromHash,
  verify,
  QsynthError,
  type CheckResult,
  type CompileResult,
  type OptimizationSummary,
  type ResourceBudget,
  type ResourceEstimate,
  type SpecKind,
  type StageRecord,
  type VerificationReport,
} from '@qsynth/core';
import { audit } from '../auth.js';
import { ApiError, invalid, notFound } from '../errors.js';
import type { Tx } from '../db.js';
import { created, ok, optionalString, orgTx, requireString, type Ctx, type Route } from '../router.js';
import * as storage from '../storage.js';

/**
 * An explicit sample count is a way to ask for more work than the default, so it needs
 * its own ceiling — `preflight` bounds the exhaustive path, not this one. 65 536 samples
 * over a few thousand gates is the same order of work the exhaustive limit permits.
 */
const MAX_SAMPLE_COUNT = 65_536;

const BUDGET_KEYS = BUDGET_FIELDS.map((f) => f.key);

/**
 * Compiler errors already answer "what went wrong" and "what to do about it"; the API
 * error is the same error with an HTTP status attached. INTERNAL is the exception — it
 * means a compiler invariant broke, which is our bug, so it is re-thrown for the handler
 * to log with its stack and report as 500 without leaking internals.
 */
function fromCompiler(error: unknown): never {
  if (!(error instanceof QsynthError)) throw error;
  if (error.code === 'INTERNAL') throw error;
  throw new ApiError(error.code, error.message, error.hint, {
    ...error.details,
    ...(error.span ? { span: error.span } : {}),
  });
}

function withCompilerErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    fromCompiler(error);
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function requireKind(body: Record<string, unknown>): SpecKind {
  const kind = body['kind'];
  if (typeof kind !== 'string' || !SPEC_KINDS.includes(kind as SpecKind)) {
    throw invalid(
      `Field "kind" must be one of: ${SPEC_KINDS.join(', ')}.`,
      'Use "boolean" for expressions and "truthtable" for tables.',
      { field: 'kind', supported: SPEC_KINDS },
    );
  }
  return kind as SpecKind;
}

/**
 * Deliberately not routed through `requireString`, which trims. The specification is
 * hashed and stored byte-for-byte as submitted, so that a hash computed locally by the
 * caller matches the one we report back.
 */
function requireSource(body: Record<string, unknown>): string {
  const source = body['source'];
  if (typeof source !== 'string' || source.trim() === '') {
    throw invalid('Field "source" is required and must be a non-empty string.', 'Include the specification text in "source".', {
      field: 'source',
    });
  }
  if (source.length > MAX_SOURCE_BYTES) {
    throw new ApiError(
      'SPEC_TOO_LARGE',
      `The specification is ${source.length} characters long; the limit is ${MAX_SOURCE_BYTES}.`,
      'Split the design into smaller modules that are compiled and verified separately.',
      { length: source.length, limit: MAX_SOURCE_BYTES },
    );
  }
  return source;
}

function parseBudget(raw: unknown): ResourceBudget | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('Field "budget" must be an object.', `Budget fields are: ${BUDGET_KEYS.join(', ')}.`, { field: 'budget' });
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) {
      throw invalid(`"${key}" is not a budget field.`, `Budget fields are: ${BUDGET_KEYS.join(', ')}.`, { field: `budget.${key}` });
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw invalid(`Budget field "${key}" must be a non-negative integer.`, 'Declare the limit as a whole number of units.', {
        field: `budget.${key}`,
      });
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as ResourceBudget) : undefined;
}

function parseSampleCount(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_SAMPLE_COUNT) {
    throw invalid(
      `Field "sampleCount" must be a whole number between 1 and ${MAX_SAMPLE_COUNT}.`,
      'Omit it to use the default, which is chosen from the size of the input space.',
      { field: 'sampleCount', limit: MAX_SAMPLE_COUNT },
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  project_id: string;
  spec_id: string;
  spec_hash: string;
  status: string;
  seed: string | number;
  compiler_version: string;
  error_code: string | null;
  error_message: string | null;
  started_at: Date;
  finished_at: Date | null;
}

const jobView = (j: JobRow) => ({
  id: j.id,
  projectId: j.project_id,
  specId: j.spec_id,
  specHash: j.spec_hash,
  status: j.status,
  seed: Number(j.seed),
  compilerVersion: j.compiler_version,
  errorCode: j.error_code,
  errorMessage: j.error_message,
  startedAt: j.started_at,
  finishedAt: j.finished_at,
});

/**
 * Reversible-layer and Clifford+T figures are kept in separate objects, and the second
 * carries its own `source`. Flattening them would invite reading a projection as if it
 * had been counted — the one misreading the estimate must not allow. A full compile
 * decomposes before estimating, so its Clifford+T figures say `measured`; the estimate
 * fast path stops earlier and says `projected`.
 */
const resourceView = (e: ResourceEstimate) => ({
  measured: {
    qubits: e.qubits,
    inputQubits: e.inputQubits,
    ancillaQubits: e.ancillaQubits,
    outputQubits: e.outputQubits,
    gateCount: e.gateCount,
    gatesByKind: e.gatesByKind,
    multiQubitGates: e.multiQubitGates,
    depth: e.depth,
  },
  cliffordT: e.cliffordT,
});

const reportView = (report: VerificationReport) => ({
  passed: report.passed,
  checks: report.checks,
  checksReached: report.checksReached,
  stoppedAt: report.stoppedAt ?? null,
  durationMs: report.durationMs,
  compilerVersion: report.compilerVersion,
  specHash: report.specHash,
  // Reported next to the verdict rather than next to the resource figures, because the
  // one thing a caller must be able to see is `discarded` — a non-zero count means a pass
  // rewrote the circuit wrongly and the guard threw the rewrite away. The compile still
  // succeeded and the artifact is still correct, so nothing else in this response would
  // hint that it happened.
  optimization: report.optimization ?? null,
});

/** The coverage mode the equivalence check actually used, for the stored report row. */
function methodOf(report: VerificationReport): { method: 'exhaustive' | 'sampled'; sampleCount: number | null } {
  const coverage = report.checks.find((c) => c.id === 'simulation_equivalence')?.coverage;
  if (!coverage) return { method: 'exhaustive', sampleCount: null };
  return { method: coverage.mode, sampleCount: coverage.mode === 'sampled' ? coverage.checked : null };
}

/** The single check that stopped the run, trimmed to what a caller can act on. */
function failureDetail(report: VerificationReport): Record<string, unknown> {
  const failed = report.checks.find((c) => c.status === 'failed');
  if (!failed) return {};
  return {
    check: {
      id: failed.id,
      title: failed.title,
      summary: failed.summary,
      ...(failed.counterexample ? { counterexample: failed.counterexample } : {}),
      ...(failed.evidence ? { evidence: failed.evidence } : {}),
    },
    checksReached: report.checksReached,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface SpecRow {
  id: string;
  name: string;
  kind: string;
  source: string;
  budgets: Record<string, unknown>;
  content_hash: string;
}

/**
 * Specs are content-addressed within a project: recompiling unchanged text reuses the
 * row rather than accumulating identical copies, which is what makes the version chain
 * on `circuit_versions` mean "this spec, compiled again" instead of "a new spec that
 * happens to read the same".
 */
async function upsertSpec(
  tx: Tx,
  ctx: Ctx,
  input: { projectId: string; name: string; kind: SpecKind; source: string; budget: ResourceBudget | undefined; hash: string },
): Promise<SpecRow> {
  const existing = await tx.one<SpecRow>(
    'select * from specs where project_id = $1 and content_hash = $2 and kind = $3',
    [input.projectId, input.hash, input.kind],
  );
  if (existing) return existing;

  const row = await tx.one<SpecRow>(
    `insert into specs (org_id, project_id, name, kind, source, budgets, content_hash, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      ctx.principal.orgId,
      input.projectId,
      input.name,
      input.kind,
      input.source,
      JSON.stringify(input.budget ?? {}),
      input.hash,
      ctx.principal.kind === 'session' ? ctx.principal.userId : null,
    ],
  );
  return row!;
}

interface ArtifactUpload {
  readonly kind: 'qasm3' | 'reversible_ir' | 'quantum_ir' | 'trace';
  readonly contentType: string;
  readonly body: string;
}

/**
 * What goes to object storage. The verification report and the resource estimate are
 * deliberately absent: they live in their own tables, where the export gate can read the
 * verdict in the same query that resolves the artifact. A second copy in S3 would be a
 * second source of truth for the one fact that must have exactly one.
 */
function uploads(result: CompileResult): readonly ArtifactUpload[] {
  return [
    { kind: 'qasm3', contentType: 'text/plain; charset=utf-8', body: result.qasm },
    { kind: 'reversible_ir', contentType: 'application/json', body: JSON.stringify(result.circuit) },
    // Both IR layers are kept. The QASM is emitted from the quantum circuit, so the
    // reversible form is the only record of what the decomposition came from — and it is
    // the layer the equivalence check ran at, which a reviewer re-checking the verdict
    // needs in hand.
    { kind: 'quantum_ir', contentType: 'application/json', body: JSON.stringify(result.quantum) },
    { kind: 'trace', contentType: 'application/json', body: JSON.stringify(result.trace) },
  ];
}

async function recordArtifacts(
  tx: Tx,
  orgId: string,
  jobId: string,
  stored: readonly (ArtifactUpload & storage.StoredArtifact)[],
): Promise<{ id: string; kind: string; contentHash: string; sizeBytes: number }[]> {
  const out: { id: string; kind: string; contentHash: string; sizeBytes: number }[] = [];
  for (const item of stored) {
    // Identical bytes within an organization are one row; a re-compile of an unchanged
    // spec therefore links the existing artifact instead of duplicating it.
    const row = await tx.one<{ id: string }>(
      `insert into artifacts (org_id, kind, content_hash, storage_uri, size_bytes)
       values ($1, $2, $3, $4, $5)
       on conflict (org_id, content_hash) do update set storage_uri = excluded.storage_uri
       returning id`,
      [orgId, item.kind, item.contentHash, item.storageUri, item.sizeBytes],
    );
    await tx.query(
      `insert into compile_job_artifacts (org_id, job_id, artifact_id, kind)
       values ($1, $2, $3, $4) on conflict (job_id, kind) do nothing`,
      [orgId, jobId, row!.id, item.kind],
    );
    out.push({ id: row!.id, kind: item.kind, contentHash: item.contentHash, sizeBytes: item.sizeBytes });
  }
  return out;
}

async function recordStages(tx: Tx, orgId: string, jobId: string, stages: readonly StageRecord[]): Promise<void> {
  for (const [ordinal, stage] of stages.entries()) {
    await tx.query(
      `insert into compile_stages (org_id, job_id, ordinal, stage, status, duration_ms, error_code)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, jobId, ordinal, stage.stage, stage.status === 'passed' ? 'ok' : 'failed', Math.round(stage.durationMs), stage.errorCode ?? null],
    );
  }
}

/**
 * A synchronous compile has exactly one state transition, so exactly one event is
 * written. Fabricating a queued → running → succeeded chain from a single `now()` would
 * put three timestamps in the history that no clock ever measured.
 */
async function recordEvent(
  tx: Tx,
  orgId: string,
  jobId: string,
  from: string | null,
  to: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    'insert into compile_job_events (org_id, job_id, from_status, to_status, detail) values ($1,$2,$3,$4,$5)',
    [orgId, jobId, from, to, JSON.stringify(detail)],
  );
}

async function nextVersion(tx: Tx, orgId: string, specId: string, projectId: string, jobId: string) {
  const previous = await tx.one<{ id: string; version: number }>(
    'select id, version from circuit_versions where spec_id = $1 order by version desc limit 1',
    [specId],
  );
  const row = await tx.one<{ id: string; version: number }>(
    `insert into circuit_versions (org_id, project_id, spec_id, job_id, version, parent_version_id)
     values ($1, $2, $3, $4, $5, $6) returning id, version`,
    [orgId, projectId, specId, jobId, (previous?.version ?? 0) + 1, previous?.id ?? null],
  );
  return { id: row!.id, number: row!.version };
}

// ---------------------------------------------------------------------------
// POST /v1/compile
// ---------------------------------------------------------------------------

async function run(ctx: Ctx) {
  const projectId = requireString(ctx.body, 'projectId');
  const kind = requireKind(ctx.body);
  const source = requireSource(ctx.body);
  const name = optionalString(ctx.body, 'name') || 'module';
  const budget = parseBudget(ctx.body['budget']);
  const sampleCount = parseSampleCount(ctx.body['sampleCount']);
  const specHash = contentHash({ kind, source });
  const orgId = ctx.principal.orgId;

  // Parse before touching the database: a syntax error is the caller's to fix and should
  // cost neither a row nor a transaction.
  const parsed = withCompilerErrors(() => parseSpec({ kind, source, name }, new TraceRecorder()));
  const projection = preflight(parsed);

  const accepted = await orgTx(ctx, async (tx) => {
    const project = await tx.one<{ id: string }>('select id from projects where id = $1', [projectId]);
    if (!project) throw notFound('Project');

    const spec = await upsertSpec(tx, ctx, { projectId, name, kind, source, budget, hash: specHash });
    if (projection.accepted) return { rejected: false as const, spec };

    // Refused, but recorded: the user can see in the project exactly what was submitted
    // and why it was turned away, rather than only a transient error response.
    const job = await tx.one<JobRow>(
      `insert into compile_jobs (org_id, project_id, spec_id, spec_hash, status, seed, compiler_version, error_code, error_message, created_by, finished_at)
       values ($1,$2,$3,$4,'rejected',$5,$6,'BUDGET_EXCEEDED',$7,$8, now()) returning *`,
      [orgId, projectId, spec.id, specHash, seedFromHash(specHash), COMPILER_VERSION, projection.reason ?? '', ctx.principal.kind === 'session' ? ctx.principal.userId : null],
    );
    await recordEvent(tx, orgId, job!.id, null, 'rejected', { preflight: { ...projection } });
    await audit(tx, ctx.principal, {
      action: 'compile.rejected',
      resourceType: 'compile_job',
      resourceId: job!.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { specHash, projectedVerificationOps: projection.projectedVerificationOps },
    });
    return { rejected: true as const, jobId: job!.id };
  });

  if (accepted.rejected) {
    throw new ApiError('BUDGET_EXCEEDED', projection.reason!, 'Reduce the number of input bits, or split the design into smaller modules that are verified separately.', {
      jobId: accepted.jobId,
      preflight: { ...projection },
    });
  }

  const specId = accepted.spec.id;

  // The work. Pure CPU, no transaction held open across it. `compile` re-parses; that is
  // a few microseconds against a verification measured in hundreds of milliseconds, and
  // it keeps one pipeline entry point rather than two half-run ones.
  let result: CompileResult;
  try {
    result = compile({ kind, source, name, budget, sampleCount });
  } catch (error) {
    if (error instanceof QsynthError && error.code !== 'INTERNAL') {
      await orgTx(ctx, async (tx) => {
        const job = await tx.one<JobRow>(
          `insert into compile_jobs (org_id, project_id, spec_id, spec_hash, status, seed, compiler_version, error_code, error_message, created_by, finished_at)
           values ($1,$2,$3,$4,'failed',$5,$6,$7,$8,$9, now()) returning *`,
          [orgId, projectId, specId, specHash, seedFromHash(specHash), COMPILER_VERSION, error.code, error.message, ctx.principal.kind === 'session' ? ctx.principal.userId : null],
        );
        await recordEvent(tx, orgId, job!.id, null, 'failed', { code: error.code });
      });
    }
    fromCompiler(error);
  }

  const stored = await Promise.all(
    uploads(result).map(async (upload) => ({
      ...upload,
      ...(await storage.write(orgId, contentHash(upload.body), upload.contentType, upload.body)),
    })),
  );

  const { method, sampleCount: usedSamples } = methodOf(result.report);
  const status = result.report.passed ? 'succeeded' : 'failed';

  const persisted = await orgTx(ctx, async (tx) => {
    const job = await tx.one<JobRow>(
      `insert into compile_jobs (org_id, project_id, spec_id, spec_hash, status, seed, compiler_version, error_code, error_message, created_by, finished_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) returning *`,
      [
        orgId,
        projectId,
        specId,
        specHash,
        status,
        seedFromHash(specHash),
        COMPILER_VERSION,
        result.report.passed ? null : 'VERIFICATION_FAILED',
        result.report.passed ? null : result.report.checks.find((c) => c.status === 'failed')?.summary ?? null,
        ctx.principal.kind === 'session' ? ctx.principal.userId : null,
      ],
    );
    const jobId = job!.id;

    await recordStages(tx, orgId, jobId, result.stages);
    await recordEvent(tx, orgId, jobId, null, status, { durationMs: Math.round(result.durationMs), artifactHash: result.artifactHash });

    await tx.query(
      `insert into verification_reports (org_id, job_id, passed, method, sample_count, seed, checks, optimization)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orgId, jobId, result.report.passed, method, usedSamples, seedFromHash(specHash), JSON.stringify(result.report.checks),
        result.optimization ? JSON.stringify(result.optimization) : null],
    );

    const e = result.estimate;
    await tx.query(
      `insert into resource_estimates
         (org_id, job_id, qubits, ancillas, depth, gate_count, two_qubit_count, t_count, t_depth, clifford_gate_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      // Counted off the reversible circuit: qubits, ancillas, depth, gate_count. Counted
      // off the Clifford+T decomposition this compile emitted: two_qubit_count, t_count,
      // t_depth, clifford_gate_count. Both are measurements here — the estimate fast path,
      // which projects them from a table, never reaches this insert.
      [orgId, jobId, e.qubits, e.ancillaQubits, e.depth, e.gateCount,
        e.cliffordT.twoQubitGates, e.cliffordT.tCount, e.cliffordT.tDepth, e.cliffordT.gateCount],
    );

    const artifacts = await recordArtifacts(tx, orgId, jobId, stored);
    const version = await nextVersion(tx, orgId, specId, projectId, jobId);

    await audit(tx, ctx.principal, {
      action: result.report.passed ? 'compile.succeeded' : 'compile.failed',
      resourceType: 'compile_job',
      resourceId: jobId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { specHash, artifactHash: result.artifactHash, passed: result.report.passed, qubits: e.qubits },
    });

    return { job: job!, artifacts, version };
  });

  const body = {
    job: jobView(persisted.job),
    stages: result.stages,
    verification: reportView(result.report),
    resources: resourceView(result.estimate),
    artifacts: persisted.artifacts,
    version: persisted.version,
    specHash,
    artifactHash: result.artifactHash,
    gateList: result.gateList,
    qasm: result.report.passed ? result.qasm : undefined,
  };

  if (!result.report.passed) {
    throw new ApiError(
      'VERIFICATION_FAILED',
      result.report.checks.find((c) => c.status === 'failed')?.summary ?? 'Verification did not pass.',
      `The circuit was not exported. Inspect the failing check at GET /v1/compile/${persisted.job.id} and correct the specification or the declared budget.`,
      { jobId: persisted.job.id, ...failureDetail(result.report) },
    );
  }

  return created(body);
}

// ---------------------------------------------------------------------------
// POST /v1/compile/estimate
// ---------------------------------------------------------------------------

/**
 * Lower and count, without verifying. Nothing is persisted and nothing is exportable —
 * this path exists to answer "how big would this be?" while the user is still typing,
 * and an artifact produced here would be one nobody had checked.
 */
async function estimate(ctx: Ctx) {
  const kind = requireKind(ctx.body);
  const source = requireSource(ctx.body);
  const name = optionalString(ctx.body, 'name') || 'module';

  const result = withCompilerErrors(() => estimateOnly({ kind, source, name }));
  return ok({
    specHash: result.specHash,
    preflight: result.preflight,
    resources: resourceView(result.estimate),
    stages: result.stages,
    // Null when the spec was refused at pre-flight: the figures are then the unoptimized
    // ones, and saying so is the difference between an estimate and a guess.
    optimization: result.optimization,
    durationMs: result.durationMs,
    verified: false,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/compile, GET /v1/compile/{id}
// ---------------------------------------------------------------------------

async function list(ctx: Ctx) {
  const projectId = ctx.query.get('projectId');
  const limit = Math.min(Number(ctx.query.get('limit') ?? 50) || 50, 200);
  const rows = await orgTx(ctx, (tx) =>
    tx.query<JobRow & { passed: boolean | null }>(
      `select j.*, vr.passed
         from compile_jobs j
         left join verification_reports vr on vr.job_id = j.id
        where ($1::uuid is null or j.project_id = $1::uuid)
        order by j.started_at desc
        limit $2`,
      [projectId, limit],
    ),
  );
  return ok({ jobs: rows.map((r) => ({ ...jobView(r), passed: r.passed })) });
}

async function get(ctx: Ctx) {
  const id = ctx.params['id'];
  const data = await orgTx(ctx, async (tx) => {
    const job = await tx.one<JobRow>('select * from compile_jobs where id = $1', [id]);
    if (!job) throw notFound('Compile job');

    const stages = await tx.query<{ stage: string; status: string; duration_ms: number; error_code: string | null }>(
      'select stage, status, duration_ms, error_code from compile_stages where job_id = $1 order by ordinal',
      [id],
    );
    const report = await tx.one<{
      passed: boolean;
      method: string;
      sample_count: number | null;
      seed: string;
      checks: CheckResult[];
      optimization: OptimizationSummary | null;
    }>('select passed, method, sample_count, seed, checks, optimization from verification_reports where job_id = $1', [id]);
    const resources = await tx.one<Record<string, number | null>>(
      `select qubits, ancillas, depth, gate_count, two_qubit_count, t_count, t_depth, clifford_gate_count
         from resource_estimates where job_id = $1`,
      [id],
    );
    const artifacts = await tx.query<{ id: string; kind: string; content_hash: string; size_bytes: number }>(
      `select a.id, ja.kind, a.content_hash, a.size_bytes
         from compile_job_artifacts ja join artifacts a on a.id = ja.artifact_id
        where ja.job_id = $1 order by ja.kind`,
      [id],
    );
    const spec = await tx.one<SpecRow>('select * from specs where id = $1', [job.spec_id]);
    const version = await tx.one<{ id: string; version: number }>(
      'select id, version from circuit_versions where job_id = $1',
      [id],
    );
    return { job, stages, report, resources, artifacts, spec, version };
  });

  return ok({
    job: jobView(data.job),
    spec: data.spec
      ? { id: data.spec.id, name: data.spec.name, kind: data.spec.kind, source: data.spec.source, budgets: data.spec.budgets }
      : null,
    stages: data.stages.map((s) => ({ stage: s.stage, status: s.status, durationMs: s.duration_ms, errorCode: s.error_code })),
    verification: data.report
      ? {
          passed: data.report.passed,
          method: data.report.method,
          sampleCount: data.report.sample_count,
          seed: Number(data.report.seed),
          checks: data.report.checks,
          checksReached: data.report.checks.filter((c) => c.status !== 'skipped').map((c) => c.id),
          stoppedAt: data.report.checks.find((c) => c.status === 'failed')?.id ?? null,
          // NULL here means the job predates the optimizer, not that it ran and did
          // nothing — a pipeline that found nothing still writes a summary with four
          // `no_change` outcomes.
          optimization: data.report.optimization,
        }
      : null,
    // The same two-object split the compile response uses, rebuilt from the stored row.
    //
    // `source` is derived rather than stored, and `clifford_gate_count` is what derives
    // it: a row can only carry the size of a decomposition if a decomposition was built,
    // and every job compiled since that stage exists builds one. A row from before it
    // has T figures that were read off the per-gate table, and calling those `measured`
    // because they now sit in the same column as measured ones would be the exact
    // misreading the split exists to prevent.
    resources: data.resources
      ? {
          measured: {
            qubits: data.resources['qubits'],
            ancillaQubits: data.resources['ancillas'],
            depth: data.resources['depth'],
            gateCount: data.resources['gate_count'],
          },
          cliffordT: {
            source: data.resources['clifford_gate_count'] == null ? ('projected' as const) : ('measured' as const),
            twoQubitGates: data.resources['two_qubit_count'],
            tCount: data.resources['t_count'],
            tDepth: data.resources['t_depth'],
            gateCount: data.resources['clifford_gate_count'] ?? null,
          },
        }
      : null,
    artifacts: data.artifacts.map((a) => ({ id: a.id, kind: a.kind, contentHash: a.content_hash, sizeBytes: a.size_bytes })),
    version: data.version ? { id: data.version.id, number: data.version.version } : null,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/compile/{id}/verify
// ---------------------------------------------------------------------------

/**
 * Re-verification. The point is not to produce a second opinion but to make FR-7
 * falsifiable at runtime: the stored spec is recompiled with the stored seed, and the
 * result is compared check by check with the report on file. A divergence is reported as
 * a divergence — including the two compiler versions, which is the usual explanation —
 * rather than quietly overwriting the stored verdict with today's.
 */
async function reverify(ctx: Ctx) {
  const id = ctx.params['id'];
  const loaded = await orgTx(ctx, async (tx) => {
    const job = await tx.one<JobRow>('select * from compile_jobs where id = $1', [id]);
    if (!job) throw notFound('Compile job');
    const spec = await tx.one<SpecRow>('select * from specs where id = $1', [job.spec_id]);
    if (!spec) throw notFound('Specification for this job');
    const stored = await tx.one<{ passed: boolean; sample_count: number | null; checks: CheckResult[] }>(
      'select passed, sample_count, checks from verification_reports where job_id = $1',
      [id],
    );
    return { job, spec, stored };
  });

  if (!loaded.stored) {
    throw new ApiError(
      'INVALID_REQUEST',
      'This job has no verification report to re-check.',
      loaded.job.status === 'rejected'
        ? 'The job was refused before compilation; submit a smaller specification instead.'
        : 'Only jobs that completed the pipeline can be re-verified.',
      { jobId: id, status: loaded.job.status },
    );
  }

  const kind = loaded.spec.kind as SpecKind;
  const budget = parseBudget(loaded.spec.budgets);
  const report = withCompilerErrors(() => {
    const trace = new TraceRecorder();
    // Re-verification has to rebuild every stage the original compile ran — optimization
    // and decomposition included. Stopping at the reversible layer would re-check a
    // different circuit than the one that was signed off, and every job would then report
    // a divergence in check 2 that says nothing about the job. `rebuild` is the same
    // function `compile` runs, called for exactly that reason: a hand-written copy of the
    // pipeline here would drift the next time a stage is added, and the symptom would be
    // every re-verification failing rather than a build error.
    const built = rebuild(
      { kind, source: loaded.spec.source, name: loaded.spec.name, budget, sampleCount: loaded.stored!.sample_count ?? undefined },
      trace,
    );
    return verify(built.module, built.circuit, built.estimate, {
      budget,
      compilerVersion: COMPILER_VERSION,
      specHash: loaded.job.spec_hash,
      sampleCount: loaded.stored!.sample_count ?? undefined,
      seed: Number(loaded.job.seed),
      quantum: built.quantum,
      trace,
      optimization: built.optimization ?? undefined,
    });
  });

  const before = new Map(loaded.stored.checks.map((c) => [c.id, c]));
  const divergence = report.checks
    .filter((c) => before.get(c.id)?.status !== c.status || before.get(c.id)?.summary !== c.summary)
    .map((c) => ({ id: c.id, storedStatus: before.get(c.id)?.status ?? null, currentStatus: c.status, summary: c.summary }));
  const reproduced = report.passed === loaded.stored.passed && divergence.length === 0;

  await orgTx(ctx, async (tx) => {
    await recordEvent(tx, ctx.principal.orgId, id!, loaded.job.status, loaded.job.status, {
      reverified: true,
      reproduced,
      storedCompilerVersion: loaded.job.compiler_version,
      compilerVersion: COMPILER_VERSION,
    });
    await audit(tx, ctx.principal, {
      action: 'compile.reverify',
      resourceType: 'compile_job',
      resourceId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reproduced, passed: report.passed },
    });
  });

  return ok({
    jobId: id,
    reproduced,
    storedPassed: loaded.stored.passed,
    storedCompilerVersion: loaded.job.compiler_version,
    compilerVersion: COMPILER_VERSION,
    divergence,
    verification: reportView(report),
  });
}

// ---------------------------------------------------------------------------
// GET /v1/artifacts/{id} — the export gate
// ---------------------------------------------------------------------------

async function exportArtifact(ctx: Ctx) {
  const id = ctx.params['id'];
  const resolved = await orgTx(ctx, async (tx) => {
    const artifact = await tx.one<{ id: string; kind: string; content_hash: string; storage_uri: string; size_bytes: number; created_at: Date }>(
      'select * from artifacts where id = $1',
      [id],
    );
    if (!artifact) throw notFound('Artifact');

    // Authorization to export comes from a stored report, joined through the jobs that
    // produced these exact bytes. Artifacts are content-addressed, so a passing job
    // vouches for the content itself, not merely for one link to it.
    const authorizing = await tx.one<{ job_id: string; spec_hash: string }>(
      `select j.id as job_id, j.spec_hash
         from compile_job_artifacts ja
         join compile_jobs j on j.id = ja.job_id
         join verification_reports vr on vr.job_id = j.id
        where ja.artifact_id = $1 and vr.passed
        order by j.started_at limit 1`,
      [id],
    );
    return { artifact, authorizing };
  });

  if (!resolved.authorizing) {
    throw new ApiError(
      'VERIFICATION_REQUIRED',
      'This artifact has not passed verification and cannot be exported.',
      'Open the compile job to see which check failed, correct the specification, and compile again.',
      { artifactId: id, kind: resolved.artifact.kind },
    );
  }

  const authorizing = resolved.authorizing;
  const content = await storage.read(resolved.artifact.storage_uri);

  await orgTx(ctx, (tx) =>
    audit(tx, ctx.principal, {
      action: 'artifact.export',
      resourceType: 'artifact',
      resourceId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { kind: resolved.artifact.kind, contentHash: resolved.artifact.content_hash, jobId: authorizing.job_id },
    }),
  );

  return ok({
    artifact: {
      id: resolved.artifact.id,
      kind: resolved.artifact.kind,
      contentHash: resolved.artifact.content_hash,
      sizeBytes: resolved.artifact.size_bytes,
      createdAt: resolved.artifact.created_at,
    },
    verifiedBy: { jobId: authorizing.job_id, specHash: authorizing.spec_hash },
    content,
  });
}

export const compileRoutes: readonly Route[] = [
  { method: 'POST', path: '/v1/compile', doc: 'Compile a specification, verify the result, and return the circuit with its report.', auth: 'compile:run', rateLimit: 'compile', idempotent: true, handler: run },
  { method: 'POST', path: '/v1/compile/estimate', doc: 'Lower a specification and return its resource cost without verifying it.', auth: 'compile:run', rateLimit: 'compile', handler: estimate },
  { method: 'GET', path: '/v1/compile', doc: 'List compile jobs in the organization, newest first.', auth: 'compile:read', handler: list },
  { method: 'GET', path: '/v1/compile/:id', doc: 'Fetch one compile job with its stages, verification report, and resource estimate.', auth: 'compile:read', handler: get },
  { method: 'POST', path: '/v1/compile/:id/verify', doc: 'Re-run verification against the stored artifacts of an existing job.', auth: 'compile:run', rateLimit: 'compile', handler: reverify },
  { method: 'GET', path: '/v1/artifacts/:id', doc: "Download an artifact's bytes. Refused unless a passing report vouches for them.", auth: 'artifact:read', handler: exportArtifact },
];
