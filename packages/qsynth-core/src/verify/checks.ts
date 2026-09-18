/**
 * The six checks (FR-4), in order, short-circuiting on the first failure.
 *
 * The order is not arbitrary — each check assumes the previous one held. Comparing
 * outputs is meaningless if the shapes disagree (1 before 2); an ancilla verdict is
 * meaningless if the circuit computes the wrong function (2 before 4). Stopping at the
 * first failure therefore reports the *cause* rather than a cascade of consequences, and
 * the report says plainly which checks never ran.
 *
 * Everything here is exact integer work. There is no numerical tolerance at this layer
 * because there are no numbers: reversible gates permute basis states. Tolerance enters
 * only at the Clifford+T layer, and check 3's contract mentions it for that reason.
 */
import type { ClassicalModule } from '../ir/classical.js';
import { ARITY, EXHAUSTIVE_INPUT_LIMIT } from '../ir/classical.js';
import type { ReversibleCircuit } from '../ir/reversible.js';
import { GATE_ARITY, invert, targetsOf } from '../ir/reversible.js';
import { assignmentToBits, evaluate, type Bit } from '../eval/classical.js';
import { initialState, run, simulate } from '../sim/basisState.js';
import type { ResourceBudget, ResourceEstimate } from '../estimate/resources.js';
import { BUDGET_FIELDS } from '../estimate/resources.js';
import { Rng } from '../util/rng.js';
import type { TraceRecorder } from '../trace/trace.js';
import {
  buildReport,
  CHECK_ORDER,
  CHECK_TITLES,
  skipped,
  type CheckId,
  type CheckResult,
  type Counterexample,
  type Coverage,
  type VerificationReport,
} from './report.js';

export interface VerifyOptions {
  readonly budget?: ResourceBudget;
  readonly compilerVersion: string;
  readonly specHash: string;
  /** Sample count when the input space is too large to enumerate. */
  readonly sampleCount?: number;
  readonly seed?: number;
  readonly exhaustiveLimit?: number;
  readonly trace?: TraceRecorder;
}

/** Basis states used by check 3; reversibility is structural, so it needs points, not coverage. */
const REVERSIBILITY_SAMPLES = 256;

export function verify(
  module: ClassicalModule,
  circuit: ReversibleCircuit,
  estimate: ResourceEstimate,
  options: VerifyOptions,
): VerificationReport {
  const started = now();
  const results: CheckResult[] = [];
  let stopped: CheckId | undefined;

  const runners: Record<CheckId, () => CheckResult> = {
    type_shape: () => checkTypeShape(module, circuit),
    simulation_equivalence: () => checkEquivalence(module, circuit, options),
    reversibility: () => checkReversibility(module, circuit, options),
    garbage_free: () => checkGarbageFree(module, circuit, options),
    property: () => checkProperties(module, circuit, options),
    resource: () => checkResources(estimate, options.budget),
  };

  for (const id of CHECK_ORDER) {
    if (stopped) {
      results.push(skipped(id, `Not run: the ${CHECK_TITLES[stopped].toLowerCase()} check failed first.`));
      continue;
    }
    const result = runners[id]();
    results.push(result);
    options.trace?.add({
      phase: 'verify',
      kind: `check.${result.status}`,
      message: `${result.title}: ${result.summary}`,
      // No timing here on purpose: the trace is stored as a content-addressed artifact,
      // and a wall-clock number would give the same compilation a different hash on every
      // run. Per-check durations live in the verification report, which is not hashed.
      detail: { check: id, status: result.status },
    });
    if (result.status === 'failed') stopped = id;
  }

  return buildReport(results, {
    compilerVersion: options.compilerVersion,
    specHash: options.specHash,
    durationMs: now() - started,
  });
}

// --- 1. type and shape ------------------------------------------------------------

function checkTypeShape(module: ClassicalModule, circuit: ReversibleCircuit): CheckResult {
  const started = now();
  const problems: string[] = [];

  for (const node of module.nodes) {
    if (node.args.length !== ARITY[node.op]) {
      problems.push(`node ${node.id} (${node.op}) has ${node.args.length} operands, expected ${ARITY[node.op]}`);
    }
    for (const arg of node.args) {
      if (arg < 0 || arg >= node.id) problems.push(`node ${node.id} references operand ${arg}, which is not defined before it`);
    }
  }
  for (const binding of [...module.outputs, ...module.assertions]) {
    if (module.nodes[binding.node] === undefined) problems.push(`"${binding.name}" is bound to node ${binding.node}, which does not exist`);
  }

  if (circuit.inputs.length !== module.inputs.length) {
    problems.push(`circuit has ${circuit.inputs.length} input wires for ${module.inputs.length} declared inputs`);
  }
  const expectedOutputs = module.outputs.length + module.assertions.length;
  if (circuit.outputs.length !== expectedOutputs) {
    problems.push(`circuit has ${circuit.outputs.length} output wires for ${expectedOutputs} outputs and assertions`);
  }

  for (let i = 0; i < circuit.gates.length; i++) {
    const gate = circuit.gates[i]!;
    if (gate.wires.length !== GATE_ARITY[gate.kind]) {
      problems.push(`gate ${i} (${gate.kind}) names ${gate.wires.length} wires, expected ${GATE_ARITY[gate.kind]}`);
    }
    if (new Set(gate.wires).size !== gate.wires.length) problems.push(`gate ${i} (${gate.kind}) names the same wire twice`);
    for (const w of gate.wires) {
      if (w < 0 || w >= circuit.wires.length) problems.push(`gate ${i} references wire ${w}, which is not declared`);
    }
  }

  // Inputs must be read-only for the Bennett form the later checks assume.
  const inputWires = new Set(circuit.inputs.map((i) => i.wire));
  for (let i = 0; i < circuit.gates.length; i++) {
    const gate = circuit.gates[i]!;
    for (const w of targetsOf(gate)) {
      if (inputWires.has(w)) problems.push(`gate ${i} (${gate.kind}) writes to input wire ${w}`);
    }
  }

  return {
    id: 'type_shape',
    title: CHECK_TITLES.type_shape,
    status: problems.length === 0 ? 'passed' : 'failed',
    summary:
      problems.length === 0
        ? `${module.inputs.length} input bit(s), ${module.outputs.length} output(s) and ${circuit.gates.length} gates are consistently shaped, and no gate writes to an input wire.`
        : `${problems.length} shape problem(s) found; the first is: ${problems[0]}.`,
    durationMs: now() - started,
    evidence: problems.length === 0 ? undefined : { problems: problems.slice(0, 20), total: problems.length },
  };
}

// --- 2. simulation equivalence ----------------------------------------------------

interface Plan {
  readonly assignments: number[];
  readonly coverage: Coverage;
}

function planAssignments(module: ClassicalModule, options: VerifyOptions): Plan {
  const n = module.inputs.length;
  const space = 2 ** n;
  const dontCare = new Set(module.dontCare);
  const limit = options.exhaustiveLimit ?? EXHAUSTIVE_INPUT_LIMIT;

  if (n <= limit) {
    const assignments: number[] = [];
    for (let a = 0; a < space; a++) if (!dontCare.has(a)) assignments.push(a);
    return {
      assignments,
      coverage: { mode: 'exhaustive', checked: assignments.length, space, dontCare: dontCare.size },
    };
  }

  // Above the limit the space cannot be enumerated inside a request. Sample it, and
  // record the seed and the count so the claim is reproducible rather than a promise.
  const seed = options.seed ?? 1;
  const rng = new Rng(seed);
  const wanted = options.sampleCount ?? 4096;
  const seen = new Set<number>();
  const assignments: number[] = [];
  // Bounded attempts: with a near-total don't-care set, rejection sampling would spin.
  for (let attempts = 0; attempts < wanted * 4 && assignments.length < wanted; attempts++) {
    let a = 0;
    for (let bit = 0; bit < n; bit++) if (rng.bit() === 1) a += 2 ** bit;
    if (dontCare.has(a) || seen.has(a)) continue;
    seen.add(a);
    assignments.push(a);
  }
  return {
    assignments,
    coverage: { mode: 'sampled', checked: assignments.length, space, dontCare: dontCare.size, seed },
  };
}

function namedInputs(module: ClassicalModule, bits: readonly Bit[]): Record<string, Bit> {
  const record: Record<string, Bit> = {};
  module.inputs.forEach((input, i) => (record[input.name] = bits[i]!));
  return record;
}

function checkEquivalence(module: ClassicalModule, circuit: ReversibleCircuit, options: VerifyOptions): CheckResult {
  const started = now();
  const plan = planAssignments(module, options);
  // Assertion wires are appended after the real outputs, in declaration order.
  const outputWires = module.outputs.map((_, i) => circuit.outputs[i]!.wire);

  let counterexample: Counterexample | undefined;

  for (const assignment of plan.assignments) {
    const bits = assignmentToBits(assignment, module.inputs.length);
    const expected = evaluate(module, bits).outputs;
    const state = run(circuit, initialState(circuit, bits));

    for (let i = 0; i < module.outputs.length; i++) {
      const name = module.outputs[i]!.name;
      if (state[outputWires[i]!] !== expected[name]) {
        const observed: Record<string, Bit> = {};
        module.outputs.forEach((o, j) => (observed[o.name] = state[outputWires[j]!] as Bit));
        counterexample = { inputs: namedInputs(module, bits), expected, observed, assignment };
        break;
      }
    }
    if (counterexample) break;
  }

  const { coverage } = plan;
  const scope =
    coverage.mode === 'exhaustive'
      ? `all ${coverage.checked} of ${coverage.space} input assignments`
      : `${coverage.checked} of ${coverage.space} input assignments sampled with seed ${coverage.seed}`;

  return {
    id: 'simulation_equivalence',
    title: CHECK_TITLES.simulation_equivalence,
    status: counterexample ? 'failed' : 'passed',
    summary: counterexample
      ? `The circuit disagrees with the specification on at least one input assignment (${describe(counterexample)}).`
      : `The circuit matches the specification on ${scope}` +
        (coverage.dontCare > 0 ? `, with ${coverage.dontCare} unconstrained assignment(s) excluded.` : '.'),
    durationMs: now() - started,
    coverage,
    counterexample,
  };
}

function describe(cex: Counterexample): string {
  const inputs = Object.entries(cex.inputs)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const wrong = Object.keys(cex.expected).filter((k) => cex.expected[k] !== cex.observed[k]);
  const detail = wrong.map((k) => `${k} expected ${cex.expected[k]}, got ${cex.observed[k]}`).join('; ');
  return `${inputs} → ${detail}`;
}

// --- 3. reversibility -------------------------------------------------------------

function checkReversibility(module: ClassicalModule, circuit: ReversibleCircuit, options: VerifyOptions): CheckResult {
  const started = now();
  const inverse = invert(circuit);
  const width = circuit.wires.length;
  const rng = new Rng(options.seed ?? 1);

  // Points, not coverage: U·U† = I is structural here, so a builder bug shows on almost
  // any state. The boundary states go in explicitly because off-by-one bugs favour them.
  const states: Uint8Array[] = [new Uint8Array(width), new Uint8Array(width).fill(1)];
  for (let i = 0; i < REVERSIBILITY_SAMPLES; i++) {
    const s = new Uint8Array(width);
    for (let w = 0; w < width; w++) s[w] = rng.bit();
    states.push(s);
  }
  // Plus the states the circuit is actually used with.
  for (const assignment of firstFew(module, 16)) {
    states.push(initialState(circuit, assignmentToBits(assignment, module.inputs.length)));
  }

  let failure: { start: number[]; end: number[] } | undefined;
  for (const start of states) {
    const state = Uint8Array.from(start);
    run(circuit, state);
    run(inverse, state);
    for (let w = 0; w < width; w++) {
      if (state[w] !== start[w]) {
        failure = { start: [...start], end: [...state] };
        break;
      }
    }
    if (failure) break;
  }

  return {
    id: 'reversibility',
    title: CHECK_TITLES.reversibility,
    status: failure ? 'failed' : 'passed',
    summary: failure
      ? 'Running the circuit followed by its inverse did not return the wires to their starting values, so the circuit is not reversible as built.'
      : `Running the circuit followed by its inverse returned every wire to its starting value on ${states.length} states, including the all-zero and all-one states. ` +
        'Each gate permutes basis states exactly, so this holds without a numerical tolerance.',
    durationMs: now() - started,
    evidence: failure ? { startState: failure.start, endState: failure.end } : { statesChecked: states.length, tolerance: 'exact' },
  };
}

function firstFew(module: ClassicalModule, count: number): number[] {
  const dontCare = new Set(module.dontCare);
  const out: number[] = [];
  const space = 2 ** module.inputs.length;
  for (let a = 0; a < space && out.length < count; a++) if (!dontCare.has(a)) out.push(a);
  return out;
}

// --- 4. garbage-free --------------------------------------------------------------

function checkGarbageFree(module: ClassicalModule, circuit: ReversibleCircuit, options: VerifyOptions): CheckResult {
  const started = now();
  const plan = planAssignments(module, options);

  // Per-ancilla, per the spec: "every ancilla returns to |0⟩, reported per-ancilla
  // against the ledger". A single circuit-level verdict would not tell the user which
  // part of their specification leaked.
  const dirty = new Map<number, { count: number; firstAssignment: number }>();
  let inputsDisturbed: { assignment: number; name: string } | undefined;

  for (const assignment of plan.assignments) {
    const bits = assignmentToBits(assignment, module.inputs.length);
    const result = simulate(circuit, bits);
    result.ancillasAtEnd.forEach((value, i) => {
      if (value !== 0) {
        const existing = dirty.get(i);
        if (existing) existing.count++;
        else dirty.set(i, { count: 1, firstAssignment: assignment });
      }
    });
    if (!inputsDisturbed) {
      for (let i = 0; i < bits.length; i++) {
        if (result.inputsAtEnd[i] !== bits[i]) {
          inputsDisturbed = { assignment, name: module.inputs[i]!.name };
          break;
        }
      }
    }
  }

  const ledger = circuit.ancillas.map((record, index) => ({
    wire: record.wire,
    purpose: record.purpose,
    allocatedAtGate: record.allocatedAtGate,
    uncomputedAtGate: record.uncomputedAtGate,
    releasedAtGate: record.releasedAtGate,
    returnedToZero: !dirty.has(index),
    ...(dirty.has(index) ? { dirtyOnAssignments: dirty.get(index)!.count, firstDirtyAssignment: dirty.get(index)!.firstAssignment } : {}),
  }));

  const failed = dirty.size > 0 || inputsDisturbed !== undefined;
  const summary = inputsDisturbed
    ? `Input "${inputsDisturbed.name}" did not hold its original value at the end of the circuit, so the circuit is not in Bennett form.`
    : dirty.size > 0
      ? `${dirty.size} of ${circuit.ancillas.length} ancilla(s) did not return to |0⟩; the first is wire ${ledger.find((l) => !l.returnedToZero)!.wire} (${ledger.find((l) => !l.returnedToZero)!.purpose}).`
      : `All ${circuit.ancillas.length} ancilla(s) returned to |0⟩ on ${plan.coverage.checked} input assignment(s), and every input still held its original value.`;

  return {
    id: 'garbage_free',
    title: CHECK_TITLES.garbage_free,
    status: failed ? 'failed' : 'passed',
    summary,
    durationMs: now() - started,
    coverage: plan.coverage,
    evidence: { ancillas: ledger },
  };
}

// --- 5. declared properties -------------------------------------------------------

function checkProperties(module: ClassicalModule, circuit: ReversibleCircuit, options: VerifyOptions): CheckResult {
  const started = now();
  if (module.assertions.length === 0) {
    return skipped('property', 'The specification declares no invariants, so there was nothing to check.');
  }

  const plan = planAssignments(module, options);
  // Assertion wires follow the real outputs on the circuit, in declaration order.
  const assertionWires = module.assertions.map((_, i) => circuit.outputs[module.outputs.length + i]!.wire);
  const violations = new Map<string, { assignment: number; inputs: Record<string, Bit>; count: number }>();

  for (const assignment of plan.assignments) {
    const bits = assignmentToBits(assignment, module.inputs.length);
    const state = run(circuit, initialState(circuit, bits));
    module.assertions.forEach((binding, i) => {
      if (state[assertionWires[i]!] === 1) return;
      const existing = violations.get(binding.name);
      if (existing) existing.count++;
      else violations.set(binding.name, { assignment, inputs: namedInputs(module, bits), count: 1 });
    });
  }

  const verdicts = module.assertions.map((binding, i) => ({
    name: binding.name,
    wire: assertionWires[i],
    held: !violations.has(binding.name),
    ...(violations.has(binding.name)
      ? {
          violatedOnAssignments: violations.get(binding.name)!.count,
          firstViolation: violations.get(binding.name)!.inputs,
        }
      : {}),
  }));

  const first = violations.entries().next();
  const counterexample: Counterexample | undefined = first.done
    ? undefined
    : {
        inputs: first.value[1].inputs,
        expected: { [first.value[0]]: 1 },
        observed: { [first.value[0]]: 0 },
        assignment: first.value[1].assignment,
      };

  return {
    id: 'property',
    title: CHECK_TITLES.property,
    status: violations.size === 0 ? 'passed' : 'failed',
    summary:
      violations.size === 0
        ? `All ${module.assertions.length} declared invariant(s) held on ${plan.coverage.checked} input assignment(s).`
        : `${violations.size} of ${module.assertions.length} declared invariant(s) do not hold; "${first.value![0]}" fails on ${Object.entries(first.value![1].inputs).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
    durationMs: now() - started,
    coverage: plan.coverage,
    counterexample,
    evidence: { assertions: verdicts },
  };
}

// --- 6. resource budgets ----------------------------------------------------------

function checkResources(estimate: ResourceEstimate, budget: ResourceBudget | undefined): CheckResult {
  const started = now();
  const declared = BUDGET_FIELDS.filter((f) => budget?.[f.key] !== undefined);
  if (declared.length === 0) {
    return skipped('resource', 'The specification declares no resource budgets, so there was nothing to enforce.');
  }

  const comparisons = declared.map((field) => {
    const limit = budget![field.key]!;
    const actual = field.actual(estimate);
    return { budget: field.key, label: field.label, limit, actual, withinBudget: actual <= limit, projected: field.projected };
  });
  const exceeded = comparisons.filter((c) => !c.withinBudget);

  return {
    id: 'resource',
    title: CHECK_TITLES.resource,
    status: exceeded.length === 0 ? 'passed' : 'failed',
    summary:
      exceeded.length === 0
        ? `All ${comparisons.length} declared budget(s) are met: ${comparisons.map((c) => `${c.actual}/${c.limit} ${c.label}`).join(', ')}.`
        : `${exceeded.length} declared budget(s) exceeded: ${exceeded.map((c) => `${c.label} is ${c.actual}, budget is ${c.limit}`).join('; ')}.`,
    durationMs: now() - started,
    evidence: { comparisons },
  };
}

function now(): number {
  return performance.now();
}
