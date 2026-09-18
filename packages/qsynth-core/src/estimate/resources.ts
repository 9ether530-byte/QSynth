/**
 * Resource estimation (FR-5) at the Reversible IR layer.
 *
 * Two kinds of number live here and they are deliberately not mixed:
 *
 *   - **Measured** — qubits, gate counts, depth. These are counted off the circuit and
 *     are exact.
 *   - **Projected** — T-count, T-depth, two-qubit count *after* Clifford+T decomposition.
 *     The circuit has not been decomposed yet, so these come from the per-gate table
 *     below. Every projected figure is marked as such in the estimate, because a budget
 *     failure a user cannot reproduce from the artifact they hold is worse than no number.
 *
 * The table states the standard decompositions this compiler targets:
 *
 *   | gate    | T | T-depth | CNOT | total gates |
 *   |---------|---|---------|------|-------------|
 *   | X       | 0 |       0 |    0 |           1 |
 *   | CNOT    | 0 |       0 |    1 |           1 |
 *   | Toffoli | 7 |       3 |    6 |          15 |  (7 T/T†, 6 CNOT, 2 H)
 *   | Fredkin | 7 |       3 |    8 |          17 |  (CNOT · Toffoli · CNOT)
 *
 * Task 5 replaces these projections with counts measured off the real decomposition; the
 * unit tests assert the two agree, which is what keeps this table from silently rotting.
 */
import type { GateKind, ReversibleCircuit } from '../ir/reversible.js';
import { MULTI_QUBIT, depth as circuitDepth } from '../ir/reversible.js';

export interface GateCost {
  readonly t: number;
  readonly tDepth: number;
  readonly cnot: number;
  readonly gates: number;
}

export const GATE_COST: Record<GateKind, GateCost> = {
  x: { t: 0, tDepth: 0, cnot: 0, gates: 1 },
  cnot: { t: 0, tDepth: 0, cnot: 1, gates: 1 },
  ccnot: { t: 7, tDepth: 3, cnot: 6, gates: 15 },
  cswap: { t: 7, tDepth: 3, cnot: 8, gates: 17 },
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
  /** Projected onto Clifford+T; see the note above. */
  readonly projected: {
    readonly tCount: number;
    readonly tDepth: number;
    readonly twoQubitGates: number;
    readonly gateCount: number;
    readonly basis: string;
  };
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
  readonly projected: boolean;
}[] = [
  { key: 'maxQubits', label: 'qubits', actual: (e) => e.qubits, projected: false },
  { key: 'maxGates', label: 'reversible gates', actual: (e) => e.gateCount, projected: false },
  { key: 'maxDepth', label: 'circuit depth', actual: (e) => e.depth, projected: false },
  { key: 'maxTCount', label: 'T count', actual: (e) => e.projected.tCount, projected: true },
  { key: 'maxTDepth', label: 'T depth', actual: (e) => e.projected.tDepth, projected: true },
  {
    key: 'maxTwoQubitGates',
    label: 'two-qubit gates',
    actual: (e) => e.projected.twoQubitGates,
    projected: true,
  },
];

export function estimate(circuit: ReversibleCircuit): ResourceEstimate {
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
    projected: {
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
 * A rough gate-count projection used *before* lowering, to refuse specs that would blow
 * the compile budget rather than accepting them and timing out (spec constraint 2).
 * Deliberately an over-estimate: the worst case is 3 gates per node, doubled by
 * uncomputation.
 */
export function projectGateCount(nodeCount: number): number {
  return nodeCount * 3 * 2;
}

/** Simulation work for the equivalence check: assignments × gates. */
export function projectVerificationOps(inputCount: number, projectedGates: number, exhaustiveLimit: number): number {
  const runs = inputCount <= exhaustiveLimit ? 2 ** inputCount : 2 ** exhaustiveLimit;
  return runs * projectedGates;
}
