/**
 * The compile pipeline: source → Classical IR → Reversible IR → checks → OpenQASM.
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
import { lowerBoolean } from './frontend/boolean/lower.js';
import { lowerTruthTable } from './frontend/truthtable/lower.js';
import { lowerToReversible } from './lowering/classicalToReversible.js';
import { estimate as estimateResources, projectGateCount, projectVerificationOps, type ResourceBudget, type ResourceEstimate } from './estimate/resources.js';
import { emitQasm3, gateListText } from './emit/qasm3.js';
import { verify } from './verify/checks.js';
import type { VerificationReport } from './verify/report.js';
import { TraceRecorder, type TraceEntry } from './trace/trace.js';
import { seedFromHash } from './util/rng.js';
import { COMPILER_VERSION } from './version.js';

export type SpecKind = 'boolean' | 'truthtable';

export const SPEC_KINDS: readonly SpecKind[] = ['boolean', 'truthtable'];

/**
 * The ceiling on projected simulation work. 50M basis-state gate applications is roughly
 * two seconds of the Lambda's time — comfortably inside the request budget with room for
 * the rest of the pipeline, and low enough that a pathological spec is refused rather
 * than allowed to consume the whole timeout.
 */
export const MAX_VERIFICATION_OPS = 50_000_000;

export type StageName = 'parse' | 'lower' | 'verify' | 'emit' | 'estimate';

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
}

export interface CompileResult {
  readonly module: ClassicalModule;
  readonly circuit: ReversibleCircuit;
  readonly estimate: ResourceEstimate;
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
  const projectedGates = projectGateCount(module.nodes.length);
  const ops = projectVerificationOps(module.inputs.length, projectedGates, EXHAUSTIVE_INPUT_LIMIT);
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
    default:
      throw invalidSpec(
        `Unknown specification kind "${request.kind}".`,
        `Supported kinds are: ${SPEC_KINDS.join(', ')}.`,
        { supported: SPEC_KINDS },
      );
  }
}

export function compile(request: CompileRequest): CompileResult {
  const started = performance.now();
  const trace = new TraceRecorder();
  const stages: StageRecord[] = [];
  const specHash = contentHash({ kind: request.kind, source: request.source });

  const stage = <T>(name: StageName, fn: () => T): T => {
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

  const { circuit } = stage('lower', () => lowerToReversible(module, trace));

  const resourceEstimate = stage('estimate', () => {
    const value = estimateResources(circuit);
    trace.add({
      phase: 'estimate',
      kind: 'resources',
      message:
        `The circuit uses ${value.qubits} qubit(s) — ${value.inputQubits} input, ${value.ancillaQubits} ancilla, ` +
        `${value.outputQubits} output — with ${value.gateCount} reversible gates at depth ${value.depth}. ` +
        `Decomposed to Clifford+T this is projected at ${value.projected.tCount} T gates, T-depth ${value.projected.tDepth}.`,
      detail: { ...value },
    });
    return value;
  });

  const report = stage('verify', () =>
    verify(module, circuit, resourceEstimate, {
      budget: request.budget,
      compilerVersion: COMPILER_VERSION,
      specHash,
      sampleCount: request.sampleCount,
      seed: seedFromHash(specHash),
      trace,
    }),
  );

  const qasm = stage('emit', () => {
    const text = emitQasm3(circuit, { compilerVersion: COMPILER_VERSION, specHash });
    trace.add({
      phase: 'emit',
      kind: 'qasm',
      message: `${circuit.gates.length} gate(s) were written as OpenQASM 3.0 using only gates from stdgates.inc.`,
      detail: { bytes: text.length },
    });
    return text;
  });

  return {
    module,
    circuit,
    estimate: resourceEstimate,
    report,
    qasm,
    gateList: gateListText(circuit),
    trace: trace.toArray(),
    stages,
    specHash,
    artifactHash: contentHash(qasm),
    compilerVersion: COMPILER_VERSION,
    durationMs: performance.now() - started,
  };
}

/**
 * Lower and estimate without verifying — the fast path behind `POST /v1/compile/estimate`.
 * The result deliberately has no report and no artifact hash: nothing produced here may
 * be exported, because nothing here has been checked.
 */
export interface EstimateResult {
  readonly estimate: ResourceEstimate;
  readonly preflight: Preflight;
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
  const { circuit } = lowerToReversible(module, trace);
  stages.push({ stage: 'lower', status: 'passed', durationMs: performance.now() - lowerStarted });

  const estimateStarted = performance.now();
  const value = estimateResources(circuit);
  stages.push({ stage: 'estimate', status: 'passed', durationMs: performance.now() - estimateStarted });

  return { estimate: value, preflight: check, stages, specHash, durationMs: performance.now() - started };
}
