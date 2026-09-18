/**
 * Resource estimation (FR-5).
 *
 * Figures come from two layers and they are deliberately not mixed. Qubits, reversible
 * gate counts and depth are counted off the reversible circuit. T-count, T-depth and
 * two-qubit count belong to the Clifford+T layer, and those carry a `source`:
 *
 *   - **measured** — counted off a decomposition that actually exists. This is what a
 *     full compile produces, because the decomposition is built before the estimate.
 *   - **projected** — derived from the per-gate table below, for the estimate fast path,
 *     which stops before decomposing. Marked as projected in the estimate and in every
 *     budget comparison drawn from it, because a budget failure a user cannot reproduce
 *     from the artifact they hold is worse than no number at all.
 *
 * The table states the decompositions this compiler actually emits — not the best ones
 * known:
 *
 *   | gate    | T | T-depth | CNOT | total gates |
 *   |---------|---|---------|------|-------------|
 *   | X       | 0 |       0 |    0 |           1 |
 *   | CNOT    | 0 |       0 |    1 |           1 |
 *   | Toffoli | 7 |       5 |    6 |          15 |  (7 T/T†, 6 CNOT, 2 H)
 *   | Fredkin | 7 |       5 |    8 |          17 |  (CNOT · Toffoli · CNOT)
 *
 * T-depth 5, not the 3 usually quoted for a 7-T Toffoli. The literature's 3 belongs to a
 * reordered arrangement of the same seven T gates; the sequential circuit in
 * `lowering/reversibleToQuantum.ts` is the one emitted here, and it layers into five. The
 * figure states the artifact, not the state of the art — a T-depth budget must be checked
 * against the circuit the user receives. Recovering the 3 is a scheduling optimization and
 * belongs to the pass pipeline, where the equivalence guard can police it.
 *
 * The table and the real decomposition are asserted to agree, gate for gate, in the unit
 * tests — which is what keeps a projection honest enough to refuse a job on.
 */
import type { GateKind, ReversibleCircuit } from '../ir/reversible.js';
import { MULTI_QUBIT, depth as circuitDepth } from '../ir/reversible.js';
import type { QuantumCircuit } from '../ir/quantum.js';
import {
  tCount as quantumTCount,
  tDepth as quantumTDepth,
  twoQubitCount as quantumTwoQubitCount,
} from '../ir/quantum.js';

export interface GateCost {
  readonly t: number;
  readonly tDepth: number;
  readonly cnot: number;
  readonly gates: number;
}

export const GATE_COST: Record<GateKind, GateCost> = {
  x: { t: 0, tDepth: 0, cnot: 0, gates: 1 },
  cnot: { t: 0, tDepth: 0, cnot: 1, gates: 1 },
  ccnot: { t: 7, tDepth: 5, cnot: 6, gates: 15 },
  cswap: { t: 7, tDepth: 5, cnot: 8, gates: 17 },
};

export interface ResourceEstimate {
  /** Measured. */
  readonly qubits: number;
  readonly inputQubits: number;
  readonly ancillaQubits: number;
  readonly outputQubits: number;
  readonly gateCount: number;
  readonly gatesByKind: Record<string, number>;
  readonly multiQubitGates: number;
  readonly depth: number;
  /** The Clifford+T layer; see the note above about `source`. */
  readonly cliffordT: CliffordTFigures;
}

export interface CliffordTFigures {
  /** Whether these were counted off a real decomposition or read off the table. */
  readonly source: 'measured' | 'projected';
  readonly tCount: number;
  readonly tDepth: number;
  readonly twoQubitGates: number;
  readonly gateCount: number;
  readonly basis: string;
}

/**
 * Declared budgets. Every field is optional: a budget the user did not declare is not a
 * budget of zero. Check 6 fails only on a field that is present and exceeded.
 */
export interface ResourceBudget {
  readonly maxQubits?: number;
  readonly maxGates?: number;
  readonly maxDepth?: number;
  readonly maxTCount?: number;
  readonly maxTDepth?: number;
  readonly maxTwoQubitGates?: number;
}

export const BUDGET_FIELDS: readonly {
  readonly key: keyof ResourceBudget;
  readonly label: string;
  readonly actual: (e: ResourceEstimate) => number;
  /** Which layer the figure is counted at — reported with every comparison. */
  readonly layer: 'reversible' | 'clifford+t';
}[] = [
  { key: 'maxQubits', label: 'qubits', actual: (e) => e.qubits, layer: 'reversible' },
  { key: 'maxGates', label: 'reversible gates', actual: (e) => e.gateCount, layer: 'reversible' },
  { key: 'maxDepth', label: 'circuit depth', actual: (e) => e.depth, layer: 'reversible' },
  { key: 'maxTCount', label: 'T count', actual: (e) => e.cliffordT.tCount, layer: 'clifford+t' },
  { key: 'maxTDepth', label: 'T depth', actual: (e) => e.cliffordT.tDepth, layer: 'clifford+t' },
  {
    key: 'maxTwoQubitGates',
    label: 'two-qubit gates',
    actual: (e) => e.cliffordT.twoQubitGates,
    layer: 'clifford+t',
  },
];

export function estimate(circuit: ReversibleCircuit, quantum?: QuantumCircuit): ResourceEstimate {
  const gatesByKind: Record<string, number> = {};
  let multiQubitGates = 0;
  let tCount = 0;
  let cnotCount = 0;
  let quantumGates = 0;

  for (const gate of circuit.gates) {
    gatesByKind[gate.kind] = (gatesByKind[gate.kind] ?? 0) + 1;
    if (MULTI_QUBIT.has(gate.kind)) multiQubitGates++;
    const cost = GATE_COST[gate.kind];
    tCount += cost.t;
    cnotCount += cost.cnot;
    quantumGates += cost.gates;
  }

  return {
    qubits: circuit.wires.length,
    inputQubits: circuit.inputs.length,
    ancillaQubits: circuit.ancillas.length,
    outputQubits: circuit.outputs.length,
    gateCount: circuit.gates.length,
    gatesByKind,
    multiQubitGates,
    depth: circuitDepth(circuit),
    cliffordT: quantum
      ? {
          source: 'measured',
          tCount: quantumTCount(quantum),
          tDepth: quantumTDepth(quantum),
          twoQubitGates: quantumTwoQubitCount(quantum),
          gateCount: quantum.gates.length,
          basis: 'Clifford+T, counted off the emitted decomposition',
        }
      : {
          source: 'projected',
          tCount,
          tDepth: projectedTDepth(circuit),
          twoQubitGates: cnotCount,
          gateCount: quantumGates,
          basis: 'Clifford+T, from the documented per-gate decomposition table',
        },
  };
}

/**
 * The longest chain of T-consuming gates, not the sum of them. Same as-soon-as-possible
 * layering as `depth()`, but each gate advances its wires by its own T-depth, so gates on
 * disjoint wires overlap and Cliffords cost nothing.
 */
function projectedTDepth(circuit: ReversibleCircuit): number {
  const ready = new Int32Array(circuit.wires.length);
  let maximum = 0;
  for (const gate of circuit.gates) {
    const cost = GATE_COST[gate.kind].tDepth;
    let start = 0;
    for (const w of gate.wires) start = Math.max(start, ready[w]!);
    const end = start + cost;
    for (const w of gate.wires) ready[w] = end;
    if (end > maximum) maximum = end;
  }
  return maximum;
}

/**
 * The widest compute rule in `lowering/classicalToReversible.ts`. NOR is the operator
 * that sets it: `a ∨ b = ab ⊕ a ⊕ b` costs a Toffoli and two CNOTs, and the negation adds
 * an X — four gates. Every other rule is three or fewer.
 *
 * This constant and that file have to move together, so the property suite asserts the
 * bound holds against randomly generated specifications rather than trusting the reading.
 */
export const MAX_GATES_PER_NODE = 4;

/**
 * A gate-count projection used *before* lowering, to refuse specs that would blow the
 * compile budget rather than accepting them and timing out (spec constraint 2).
 *
 * It must be an over-estimate, and that is the whole of its contract: a projection that
 * came in under the truth would let `preflight` accept a specification that then runs
 * past the ceiling, which is precisely the accept-then-timeout behaviour the pre-flight
 * check exists to prevent. Worst case is `MAX_GATES_PER_NODE` to compute a node and the
 * same again to uncompute it, plus one copy-out CNOT per output.
 */
export function projectGateCount(nodeCount: number, outputCount: number): number {
  return nodeCount * MAX_GATES_PER_NODE * 2 + outputCount;
}

/** Simulation work for the equivalence check: assignments × gates. */
export function projectVerificationOps(inputCount: number, projectedGates: number, exhaustiveLimit: number): number {
  const runs = inputCount <= exhaustiveLimit ? 2 ** inputCount : 2 ** exhaustiveLimit;
  return runs * projectedGates;
}
