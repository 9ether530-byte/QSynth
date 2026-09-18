/**
 * Reversible IR → Quantum IR: the Clifford+T decomposition.
 *
 * The whole layer is a table of four rules, one per reversible gate kind, applied
 * gate-by-gate with no context. That is the point. Because the rules are context-free
 * and the circuit is their concatenation, correctness of the layer reduces to
 * correctness of four small fixed matrices:
 *
 *     if each rule's replacement equals its gate's unitary (up to global phase),
 *     then the concatenation of replacements equals the concatenation of gates.
 *
 * So `verifyRules()` — comparing each replacement's 2^k × 2^k matrix against the exact
 * permutation the reversible gate denotes — is not a unit test that happens to live in
 * the source tree. It is the proof obligation for every circuit this compiler emits, and
 * it runs on the compile path, not only under vitest.
 *
 * The `expected` images below are written out by hand rather than computed from the
 * reversible simulator. Deriving them from the same code the rest of the compiler uses
 * would make this check agree with itself; written out, it is an independent statement
 * of what "Toffoli" means, and the two have to meet.
 */
import { QsynthError } from '../errors.js';
import type { Gate, GateKind, ReversibleCircuit } from '../ir/reversible.js';
import { QuantumBuilder, type QuantumCircuit, type QuantumGateKind } from '../ir/quantum.js';
import { circuitUnitary, differsUpToGlobalPhase, permutationUnitary, type UnitaryDifference } from '../sim/statevector.js';
import type { TraceRecorder } from '../trace/trace.js';

/** A gate in a rule's replacement, over the rule's *local* qubits 0..k-1. */
interface LocalGate {
  readonly kind: QuantumGateKind;
  readonly wires: readonly number[];
}

export interface DecompositionRule {
  readonly kind: GateKind;
  readonly qubits: number;
  /**
   * `image[k]` is the basis state |k⟩ maps to, where bit `i` of an index is local qubit
   * `i` — and local qubit `i` is the gate's `wires[i]`, so for a Toffoli bit 0 and bit 1
   * are the controls and bit 2 is the target.
   */
  readonly image: readonly number[];
  readonly replacement: readonly LocalGate[];
  /** What the rule costs, for the estimate table to be checked against. */
  readonly note: string;
}

/**
 * Toffoli in 7 T gates, 6 CNOTs and 2 Hadamards — the standard construction (Nielsen &
 * Chuang fig. 4.9). It is T-optimal for a Toffoli with no borrowed ancilla, which is why
 * it is the one worth hard-coding: T count is the figure users budget against.
 */
const TOFFOLI: readonly LocalGate[] = [
  { kind: 'h', wires: [2] },
  { kind: 'cx', wires: [1, 2] },
  { kind: 'tdg', wires: [2] },
  { kind: 'cx', wires: [0, 2] },
  { kind: 't', wires: [2] },
  { kind: 'cx', wires: [1, 2] },
  { kind: 'tdg', wires: [2] },
  { kind: 'cx', wires: [0, 2] },
  { kind: 't', wires: [1] },
  { kind: 't', wires: [2] },
  { kind: 'cx', wires: [0, 1] },
  { kind: 'h', wires: [2] },
  { kind: 't', wires: [0] },
  { kind: 'tdg', wires: [1] },
  { kind: 'cx', wires: [0, 1] },
];

/**
 * Fredkin as CNOT · Toffoli · CNOT. The two CNOTs turn the swap into a controlled flip:
 * after `a ^= b` the Toffoli writes `b ^= c·a`, and the second `a ^= b` completes the
 * exchange when c is set and undoes the first when it is not.
 */
const FREDKIN: readonly LocalGate[] = [
  { kind: 'cx', wires: [2, 1] },
  ...TOFFOLI.map((g) => ({ kind: g.kind, wires: g.wires })),
  { kind: 'cx', wires: [2, 1] },
];

export const RULES: readonly DecompositionRule[] = [
  { kind: 'x', qubits: 1, image: [1, 0], replacement: [{ kind: 'x', wires: [0] }], note: 'X is already in the gate set.' },
  {
    kind: 'cnot',
    qubits: 2,
    image: [0, 3, 2, 1],
    replacement: [{ kind: 'cx', wires: [0, 1] }],
    note: 'CNOT is already in the gate set.',
  },
  {
    kind: 'ccnot',
    qubits: 3,
    image: [0, 1, 2, 7, 4, 5, 6, 3],
    replacement: TOFFOLI,
    note: 'Toffoli → 2 H, 6 CNOT, 7 T (T-depth 5 as sequenced here).',
  },
  {
    kind: 'cswap',
    qubits: 3,
    image: [0, 1, 2, 5, 4, 3, 6, 7],
    replacement: FREDKIN,
    note: 'Fredkin → CNOT · Toffoli · CNOT: 2 H, 8 CNOT, 7 T (T-depth 5 as sequenced here).',
  },
];

const RULE_BY_KIND: Record<GateKind, DecompositionRule> = Object.fromEntries(
  RULES.map((rule) => [rule.kind, rule]),
) as Record<GateKind, DecompositionRule>;

export interface RuleVerdict {
  readonly kind: GateKind;
  readonly qubits: number;
  readonly gates: number;
  readonly tCount: number;
  readonly ok: boolean;
  readonly note: string;
  readonly difference?: UnitaryDifference;
}

export interface RuleVerification {
  readonly ok: boolean;
  readonly rules: readonly RuleVerdict[];
}

let cached: RuleVerification | undefined;

/**
 * Verify every rule against the exact matrix of the gate it replaces.
 *
 * Memoised: the table is a compile-time constant, so re-deriving the same four matrices
 * on every request would burn CPU to reach a foregone conclusion. The first compile in a
 * process pays about a millisecond; the result is reported in every verification report
 * regardless, so the claim travels with the artifact even when the work was cached.
 */
export function verifyRules(): RuleVerification {
  if (cached) return cached;

  const rules = RULES.map((rule): RuleVerdict => {
    const expected = permutationUnitary(rule.qubits, rule.image);
    const observed = circuitUnitary(rule.qubits, rule.replacement);
    const difference = differsUpToGlobalPhase(expected, observed);
    return {
      kind: rule.kind,
      qubits: rule.qubits,
      gates: rule.replacement.length,
      tCount: rule.replacement.filter((g) => g.kind === 't' || g.kind === 'tdg').length,
      ok: difference === null,
      note: rule.note,
      ...(difference ? { difference } : {}),
    };
  });

  cached = { ok: rules.every((r) => r.ok), rules };
  return cached;
}

/**
 * Lower a reversible circuit to Clifford+T.
 *
 * Wires are carried over one-for-one — the decomposition introduces no new qubits, which
 * is what keeps the qubit count in the estimate a measured figure rather than a moving
 * target between layers.
 */
export function lowerToQuantum(circuit: ReversibleCircuit, trace?: TraceRecorder): QuantumCircuit {
  const verdicts = verifyRules();
  if (!verdicts.ok) {
    const broken = verdicts.rules.filter((r) => !r.ok).map((r) => r.kind);
    throw new QsynthError(
      'INTERNAL',
      `The Clifford+T decomposition rule for ${broken.join(', ')} does not match the gate it replaces.`,
      'This is a compiler defect. Please report it with the specification that triggered it.',
      { details: { rules: verdicts.rules } },
    );
  }

  const builder = new QuantumBuilder(circuit.name, circuit.wires, circuit.inputs, circuit.outputs);
  const perKind: Record<string, number> = {};

  circuit.gates.forEach((gate: Gate, index: number) => {
    const rule = RULE_BY_KIND[gate.kind];
    perKind[gate.kind] = (perKind[gate.kind] ?? 0) + 1;
    for (const local of rule.replacement) {
      builder.emit(
        local.kind,
        local.wires.map((w) => gate.wires[w]!),
        { source: index, span: gate.span },
      );
    }
  });

  const quantum = builder.build();

  // One entry per rule used, not per gate: a trace with an entry for each of several
  // thousand decomposed gates is a log, not an explanation.
  trace?.add({
    phase: 'reversible',
    kind: 'decompose.rules',
    message:
      `All ${verdicts.rules.length} decomposition rules were checked against the exact matrix of the gate they ` +
      `replace before use, so the Clifford+T circuit is equivalent to the reversible one by construction.`,
    detail: { rules: verdicts.rules.map((r) => ({ kind: r.kind, gates: r.gates, tCount: r.tCount, ok: r.ok })) },
  });
  for (const rule of RULES) {
    const used = perKind[rule.kind];
    if (!used) continue;
    trace?.add({
      phase: 'reversible',
      kind: 'decompose.gate',
      message:
        `${used} ${LABEL[rule.kind]} gate(s) were decomposed into ${used * rule.replacement.length} Clifford+T ` +
        `gate(s), contributing ${used * ruleTCount(rule)} T gate(s). ${rule.note}`,
      detail: { kind: rule.kind, count: used, gatesEach: rule.replacement.length, tEach: ruleTCount(rule) },
    });
  }

  return quantum;
}

function ruleTCount(rule: DecompositionRule): number {
  return rule.replacement.filter((g) => g.kind === 't' || g.kind === 'tdg').length;
}

const LABEL: Record<GateKind, string> = { x: 'NOT', cnot: 'CNOT', ccnot: 'Toffoli', cswap: 'Fredkin' };

/**
 * The reversible circuit read directly as a quantum circuit, without decomposing. Only
 * valid for circuits made of X and CNOT, which are already in the Clifford+T set — used
 * as the reference side of the tableau equivalence check.
 */
export function asQuantumDirect(circuit: ReversibleCircuit): QuantumCircuit | null {
  const builder = new QuantumBuilder(circuit.name, circuit.wires, circuit.inputs, circuit.outputs);
  for (const [index, gate] of circuit.gates.entries()) {
    if (gate.kind === 'x') builder.emit('x', gate.wires, { source: index });
    else if (gate.kind === 'cnot') builder.emit('cx', gate.wires, { source: index });
    else return null;
  }
  return builder.build();
}
