/**
 * The compile pipeline: source → Classical IR → Reversible IR → Clifford+T → checks →
 * OpenQASM.
 *
 * Two things this file is responsible for beyond sequencing.
 *
 * **Refusing before accepting.** A spec whose verification would not finish inside the
 * request budget is rejected at the pre-flight stage with the projected figures, not
 * accepted and then timed out. A timeout tells the user nothing they can act on; a
 * refusal that says "this needs ~400M simulation steps, the ceiling is 50M" tells them
 * exactly what to change.
 *
 * **Per-stage attribution.** Every stage records its own duration and outcome, so a slow
 * or failing compile can be localised without instrumenting anything further. The API
 * returns these verbatim — the UI's progress display is real measurement, not animation.
 *
 * Verification runs unconditionally. There is no flag to skip it, because a caller who
 * could skip it could produce an artifact with no report, and the export gate would then
 * be guarding an empty seat.
 */
import { QsynthError, invalidSpec } from './errors.js';
import { contentHash } from './hash.js';
import { EXHAUSTIVE_INPUT_LIMIT, type ClassicalModule } from './ir/classical.js';
import type { ReversibleCircuit } from './ir/reversible.js';
import type { QuantumCircuit } from './ir/quantum.js';
import { lowerBoolean } from './frontend/boolean/lower.js';
import { lowerTruthTable } from './frontend/truthtable/lower.js';
import { lowerPython } from './frontend/python/lower.js';
import { lowerToReversible } from './lowering/classicalToReversible.js';
import { lowerToQuantum } from './lowering/reversibleToQuantum.js';
import { estimate as estimateResources, projectGateCount, projectVerificationOps, type ResourceBudget, type ResourceEstimate } from './estimate/resources.js';
import { emitQasm3, gateListText } from './emit/qasm3.js';
import { verify } from './verify/checks.js';
import { planAssignments } from './verify/plan.js';
import { optimize, OPTIMIZATION_PASSES } from './passes/runner.js';
import type { OptimizationSummary } from './passes/types.js';
import type { VerificationReport } from './verify/report.js';
import { TraceRecorder, type TraceEntry } from './trace/trace.js';
import { seedFromHash } from './util/rng.js';
import { COMPILER_VERSION } from './version.js';

export type SpecKind = 'boolean' | 'truthtable' | 'python';

export const SPEC_KINDS: readonly SpecKind[] = ['boolean', 'truthtable', 'python'];

/**
 * The ceiling on projected simulation work. 50M basis-state gate applications is roughly
 * two seconds of the Lambda's time — comfortably inside the request budget with room for
 * the rest of the pipeline, and low enough that a pathological spec is refused rather
 * than allowed to consume the whole timeout.
 */
export const MAX_VERIFICATION_OPS = 50_000_000;

/**
 * How many times a compile simulates the whole circuit across the assignment plan. The
 * pre-flight projection multiplies by this, because a ceiling that counted one sweep when
 * the pipeline performs seven would accept specs that then run seven times over it — and
 * refusing before accepting is the entire point of the check.
 *
 * Three sweeps for the checks — equivalence, garbage-freedom, and declared properties —
 * plus the optimizer's reference sweep and one per pass that rewrites anything.
 */
export const VERIFICATION_SWEEPS = 3 + 1 + OPTIMIZATION_PASSES.length;

export type StageName = 'parse' | 'lower' | 'optimize' | 'decompose' | 'estimate' | 'verify' | 'emit';

export interface StageRecord {
  readonly stage: StageName;
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly errorCode?: string;
}

export interface CompileRequest {
  readonly kind: SpecKind;
  readonly source: string;
  readonly name?: string;
  readonly budget?: ResourceBudget;
  /** Sample count when the input space is too large to enumerate exhaustively. */
  readonly sampleCount?: number;
  /**
   * Run the optimizer. Default on. Turning it off is for comparing against the
   * unoptimized circuit, not for working around a bad pass — a bad pass is discarded by
   * the guard and reported, and switching the whole optimizer off to avoid one would hide
   * that it happened.
   */
  readonly optimize?: boolean;
}

/** Everything `rebuild` produced, plus the verdict and the artifact. */
export interface CompileResult extends Rebuilt {
  readonly report: VerificationReport;
  readonly qasm: string;
  readonly gateList: string;
  readonly trace: readonly TraceEntry[];
  readonly stages: readonly StageRecord[];
  readonly specHash: string;
  readonly artifactHash: string;
  readonly compilerVersion: string;
  readonly durationMs: number;
}

/** A spec that will be refused, and why — used by the API before it accepts the job. */
export interface Preflight {
  readonly accepted: boolean;
  readonly nodes: number;
  readonly inputs: number;
  readonly projectedGates: number;
  readonly projectedVerificationOps: number;
  readonly limit: number;
  readonly reason?: string;
}

export function preflight(module: ClassicalModule): Preflight {
  const projectedGates = projectGateCount(module.nodes.length, module.outputs.length);
  const ops = projectVerificationOps(module.inputs.length, projectedGates, EXHAUSTIVE_INPUT_LIMIT, VERIFICATION_SWEEPS);
  const accepted = ops <= MAX_VERIFICATION_OPS;
  return {
    accepted,
    nodes: module.nodes.length,
    inputs: module.inputs.length,
    projectedGates,
    projectedVerificationOps: ops,
    limit: MAX_VERIFICATION_OPS,
    reason: accepted
      ? undefined
      : `Verifying this specification is projected to take about ${Math.round(ops / 1e6)} million simulation steps; ` +
        `the limit for a single request is ${MAX_VERIFICATION_OPS / 1e6} million. ` +
        `It has ${module.inputs.length} input bit(s) and ${module.nodes.length} operation(s).`,
  };
}

export function parseSpec(request: CompileRequest, trace: TraceRecorder): ClassicalModule {
  const name = request.name ?? 'module';
  switch (request.kind) {
    case 'boolean':
      return lowerBoolean(request.source, { moduleName: name, trace });
    case 'truthtable':
      return lowerTruthTable(request.source, { moduleName: name, trace });
    case 'python':
      // The module takes its name from the `def` unless the caller named the spec, so a
      // file that reads `def full_adder(...)` produces a circuit called `full_adder`
      // rather than `module`.
      return lowerPython(request.source, { moduleName: request.name, trace });
    default:
      throw invalidSpec(
        `Unknown specification kind "${request.kind}".`,
        `Supported kinds are: ${SPEC_KINDS.join(', ')}.`,
        { supported: SPEC_KINDS },
      );
  }
}

/**
 * Everything up to verification: parse, lower, optimize, decompose, estimate.
 *
 * This exists as one function because two callers need the *same* circuit and there is no
 * safe way for them to build it separately. `compile` runs it to produce an artifact;
 * `POST /v1/compile/{id}/verify` runs it again months later to re-check that artifact
 * against the stored report. If the second caller rebuilt the pipeline by hand it would
 * drift the moment a stage was added — and the symptom would not be a build error, it
 * would be every re-verification reporting a divergence that says nothing about the job.
 *
 * `stage` is the only thing the two callers differ on: `compile` passes a wrapper that
 * times and records each step, and everyone else takes the default and just runs it.
 */
export interface Rebuilt {
  readonly module: ClassicalModule;
  /** The circuit that gets verified and emitted — optimized, when the optimizer ran. */
  readonly circuit: ReversibleCircuit;
  readonly unoptimized: ReversibleCircuit;
  readonly optimization: OptimizationSummary | null;
  readonly quantum: QuantumCircuit;
  readonly estimate: ResourceEstimate;
  readonly specHash: string;
}

export type StageRunner = <T>(name: StageName, fn: () => T) => T;

const runDirectly: StageRunner = (_name, fn) => fn();

export function rebuild(request: CompileRequest, trace: TraceRecorder, stage: StageRunner = runDirectly): Rebuilt {
  const specHash = contentHash({ kind: request.kind, source: request.source });

  const module = stage('parse', () => {
    const parsed = parseSpec(request, trace);
    const check = preflight(parsed);
    if (!check.accepted) {
      throw new QsynthError(
        'BUDGET_EXCEEDED',
        check.reason!,
        'Reduce the number of input bits, or split the design into smaller modules that are verified separately.',
        { details: { ...check } },
      );
    }
    trace.add({
      phase: 'parse',
      kind: 'preflight',
      message:
        `The specification has ${check.inputs} input bit(s) and ${check.nodes} operation(s); verification is ` +
        `projected to take about ${check.projectedVerificationOps.toLocaleString('en-US')} simulation steps.`,
      detail: { ...check },
    });
    return parsed;
  });

  const { circuit: lowered } = stage('lower', () => lowerToReversible(module, trace));

  // The plan is built once and shared. The guard has to judge a rewrite on exactly the
  // assignments the checks will judge the circuit on — see verify/plan.ts.
  const plan = planAssignments(module, { sampleCount: request.sampleCount, seed: seedFromHash(specHash) });

  const optimized = stage('optimize', () =>
    request.optimize === false ? null : optimize(module, lowered, { plan, trace }),
  );
  const circuit = optimized?.circuit ?? lowered;

  // Decomposing before estimating is what turns the Clifford+T figures from a projection
  // into a measurement — the budget check then runs against the circuit that gets emitted.
  const quantum = stage('decompose', () => lowerToQuantum(circuit, trace));

  const resourceEstimate = stage('estimate', () => {
    const value = estimateResources(circuit, quantum);
    trace.add({
      phase: 'estimate',
      kind: 'resources',
      message:
        `The circuit uses ${value.qubits} qubit(s) — ${value.inputQubits} input, ${value.ancillaQubits} ancilla, ` +
        `${value.outputQubits} output — with ${value.gateCount} reversible gates at depth ${value.depth}. ` +
        `Its Clifford+T decomposition has ${value.cliffordT.gateCount} gates, of which ${value.cliffordT.tCount} are T, ` +
        `at T-depth ${value.cliffordT.tDepth} — counted off the decomposition, not projected.`,
      detail: { ...value },
    });
    return value;
  });

  return {
    module,
    circuit,
    unoptimized: lowered,
    optimization: optimized?.summary ?? null,
    quantum,
    estimate: resourceEstimate,
    specHash,
  };
}

export function compile(request: CompileRequest): CompileResult {
  const started = performance.now();
  const trace = new TraceRecorder();
  const stages: StageRecord[] = [];

  const stage: StageRunner = (name, fn) => {
    const stageStarted = performance.now();
    try {
      const value = fn();
      stages.push({ stage: name, status: 'passed', durationMs: performance.now() - stageStarted });
      return value;
    } catch (error) {
      stages.push({
        stage: name,
        status: 'failed',
        durationMs: performance.now() - stageStarted,
        errorCode: error instanceof QsynthError ? error.code : 'INTERNAL',
      });
      throw error;
    }
  };

  const built = rebuild(request, trace, stage);
  const { module, circuit, quantum, specHash } = built;

  const report = stage('verify', () =>
    verify(module, circuit, built.estimate, {
      budget: request.budget,
      compilerVersion: COMPILER_VERSION,
      specHash,
      sampleCount: request.sampleCount,
      seed: seedFromHash(specHash),
      quantum,
      trace,
      optimization: built.optimization ?? undefined,
    }),
  );

  const qasm = stage('emit', () => {
    const text = emitQasm3(quantum, { compilerVersion: COMPILER_VERSION, specHash });
    trace.add({
      phase: 'emit',
      kind: 'qasm',
      message:
        `${quantum.gates.length} Clifford+T gate(s) were written as OpenQASM 3.0 using only gates from stdgates.inc. ` +
        `The emitted circuit is the decomposition, so the file is the circuit that was verified.`,
      detail: { bytes: text.length, gates: quantum.gates.length },
    });
    return text;
  });

  return {
    ...built,
    report,
    qasm,
    gateList: gateListText(circuit),
    trace: trace.toArray(),
    stages,
    artifactHash: contentHash(qasm),
    compilerVersion: COMPILER_VERSION,
    durationMs: performance.now() - started,
  };
}

/**
 * Lower, optimize and estimate without verifying — the fast path behind
 * `POST /v1/compile/estimate`. The result deliberately has no report and no artifact
 * hash: nothing produced here may be exported, because nothing here has been checked.
 *
 * What it skips is verification and the Clifford+T decomposition, not optimization. An
 * estimate is answering "what will I get if I compile this", and a figure quoted from the
 * unoptimized circuit answers a question nobody asked — it would report qubits and gates
 * the compile is about to remove. The optimizer's guard still runs, so the figures come
 * from a circuit that has been re-checked against the one lowering produced.
 */
export interface EstimateResult {
  readonly estimate: ResourceEstimate;
  readonly preflight: Preflight;
  readonly optimization: OptimizationSummary | null;
  readonly stages: readonly StageRecord[];
  readonly specHash: string;
  readonly durationMs: number;
}

export function estimateOnly(request: CompileRequest): EstimateResult {
  const started = performance.now();
  const trace = new TraceRecorder();
  const specHash = contentHash({ kind: request.kind, source: request.source });
  const stages: StageRecord[] = [];

  const parseStarted = performance.now();
  const module = parseSpec(request, trace);
  stages.push({ stage: 'parse', status: 'passed', durationMs: performance.now() - parseStarted });

  const check = preflight(module);

  const lowerStarted = performance.now();
  const { circuit: lowered } = lowerToReversible(module, trace);
  stages.push({ stage: 'lower', status: 'passed', durationMs: performance.now() - lowerStarted });

  // Optimize only when the spec would have been accepted for a full compile. The guard's
  // sweeps are exactly the simulation work the pre-flight ceiling exists to refuse, and
  // running them here on a spec the compiler would turn away is the accept-then-timeout
  // behaviour in a different costume. The caller is told what it got either way: an
  // estimate of a refused spec comes back with `optimization: null`.
  const optimizeStarted = performance.now();
  const optimized =
    request.optimize === false || !check.accepted
      ? null
      : optimize(module, lowered, {
          plan: planAssignments(module, { sampleCount: request.sampleCount, seed: seedFromHash(specHash) }),
          trace,
        });
  stages.push({ stage: 'optimize', status: 'passed', durationMs: performance.now() - optimizeStarted });
  const circuit = optimized?.circuit ?? lowered;

  const estimateStarted = performance.now();
  const value = estimateResources(circuit);
  stages.push({ stage: 'estimate', status: 'passed', durationMs: performance.now() - estimateStarted });

  return {
    estimate: value,
    preflight: check,
    optimization: optimized?.summary ?? null,
    stages,
    specHash,
    durationMs: performance.now() - started,
  };
}
