/**
 * Quantum IR — a circuit over the Clifford+T gate set.
 *
 * This is the last IR before OpenQASM, and the first one where a state is not just a
 * basis state: H and T take a qubit into superposition, so the cheap basis-state
 * reasoning that carries the reversible layer stops applying here.
 *
 * The gate set is fixed and discrete — no continuous rotation angles. That is a
 * deliberate restriction, not a simplification:
 *
 *   - **T count and T depth become exact.** On a fault-tolerant machine the T gate is
 *     the expensive one by orders of magnitude, so an exact count is the number users
 *     budget against. An `rz(θ)` in the IR would make it an approximation with an error
 *     parameter attached, and FR-5 asks for a figure, not an interval.
 *   - **Verification stays finite.** Every gate here is exactly representable in the
 *     ring ℤ[1/√2, i], so simulation is exact up to floating-point rounding rather than
 *     approximate by construction, and a circuit with no T gates is Clifford — which the
 *     stabilizer simulator handles in polynomial time at any width.
 *
 * `source` links each gate back to the index of the reversible gate it came from. The
 * workbench uses it to highlight, and the decomposition check uses it to report which
 * reversible gate a failing rule belongs to.
 */
import { assertInvariant } from '../errors.js';
import type { Span } from '../errors.js';
import type { Wire } from './reversible.js';

/** Clifford+T. `sdg`/`tdg` are the adjoints of `s`/`t`. */
export type QuantumGateKind = 'x' | 'y' | 'z' | 'h' | 's' | 'sdg' | 't' | 'tdg' | 'cx';

export const QUANTUM_ARITY: Record<QuantumGateKind, number> = {
  x: 1,
  y: 1,
  z: 1,
  h: 1,
  s: 1,
  sdg: 1,
  t: 1,
  tdg: 1,
  cx: 2,
};

/** The non-Clifford gates. Everything else is in the Clifford group. */
export const NON_CLIFFORD: ReadonlySet<QuantumGateKind> = new Set<QuantumGateKind>(['t', 'tdg']);

export interface QuantumGate {
  readonly kind: QuantumGateKind;
  /** Single-qubit: [target]. cx: [control, target]. */
  readonly wires: readonly number[];
  /** Index of the reversible gate this came from, for trace linking. */
  readonly source?: number;
  readonly span?: Span;
}

export interface QuantumCircuit {
  readonly name: string;
  readonly wires: readonly Wire[];
  readonly gates: readonly QuantumGate[];
  readonly inputs: readonly { readonly name: string; readonly wire: number }[];
  readonly outputs: readonly { readonly name: string; readonly wire: number }[];
  readonly basis: 'clifford+t';
}

export function isClifford(circuit: QuantumCircuit): boolean {
  return !circuit.gates.some((g) => NON_CLIFFORD.has(g.kind));
}

export function gateCount(circuit: QuantumCircuit): number {
  return circuit.gates.length;
}

export function tCount(circuit: QuantumCircuit): number {
  return circuit.gates.reduce((n, g) => n + (NON_CLIFFORD.has(g.kind) ? 1 : 0), 0);
}

export function twoQubitCount(circuit: QuantumCircuit): number {
  return circuit.gates.reduce((n, g) => n + (g.wires.length > 1 ? 1 : 0), 0);
}

export function gatesByKind(circuit: QuantumCircuit): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const gate of circuit.gates) counts[gate.kind] = (counts[gate.kind] ?? 0) + 1;
  return counts;
}

/** Longest chain of gates that must run in sequence, over all gates. */
export function depth(circuit: QuantumCircuit): number {
  const ready = new Int32Array(circuit.wires.length);
  let maximum = 0;
  for (const gate of circuit.gates) {
    let layer = 0;
    for (const w of gate.wires) layer = Math.max(layer, ready[w]!);
    const next = layer + 1;
    for (const w of gate.wires) ready[w] = next;
    if (next > maximum) maximum = next;
  }
  return maximum;
}

/**
 * T depth: the number of layers containing at least one T. This is the figure that
 * matters on a fault-tolerant machine, where T gates are consumed from a distillation
 * factory and Clifford gates are comparatively free — so the schedule's cost is the
 * number of *rounds* of T, not their total count.
 *
 * Layers are assigned by the same as-soon-as-possible packing used for depth, then the
 * T-bearing ones are counted. Gates that are not T still occupy their wire (they impose
 * ordering) but do not themselves open a T layer.
 */
export function tDepth(circuit: QuantumCircuit): number {
  const ready = new Int32Array(circuit.wires.length);
  const tLayers = new Set<number>();
  for (const gate of circuit.gates) {
    let layer = 0;
    for (const w of gate.wires) layer = Math.max(layer, ready[w]!);
    for (const w of gate.wires) ready[w] = layer + 1;
    if (NON_CLIFFORD.has(gate.kind)) tLayers.add(layer);
  }
  return tLayers.size;
}

export class QuantumBuilder {
  private readonly gates: QuantumGate[] = [];

  constructor(
    private readonly name: string,
    private readonly wires: readonly Wire[],
    private readonly inputs: readonly { readonly name: string; readonly wire: number }[],
    private readonly outputs: readonly { readonly name: string; readonly wire: number }[],
  ) {}

  emit(kind: QuantumGateKind, wires: readonly number[], opts: { source?: number; span?: Span } = {}): void {
    assertInvariant(wires.length === QUANTUM_ARITY[kind], `${kind} takes ${QUANTUM_ARITY[kind]} qubit(s), got ${wires.length}`);
    assertInvariant(new Set(wires).size === wires.length, `${kind} names the same qubit twice`);
    for (const w of wires) assertInvariant(w >= 0 && w < this.wires.length, `gate references undeclared qubit ${w}`);
    this.gates.push({ kind, wires: [...wires], source: opts.source, span: opts.span });
  }

  build(): QuantumCircuit {
    return {
      name: this.name,
      wires: [...this.wires],
      gates: [...this.gates],
      inputs: [...this.inputs],
      outputs: [...this.outputs],
      basis: 'clifford+t',
    };
  }
}

/** The adjoint of a circuit: gates reversed, each replaced by its own adjoint. */
export const ADJOINT: Record<QuantumGateKind, QuantumGateKind> = {
  x: 'x',
  y: 'y',
  z: 'z',
  h: 'h',
  s: 'sdg',
  sdg: 's',
  t: 'tdg',
  tdg: 't',
  cx: 'cx',
};

export function adjoint(circuit: QuantumCircuit): QuantumCircuit {
  return {
    ...circuit,
    gates: [...circuit.gates].reverse().map((g) => ({ ...g, kind: ADJOINT[g.kind] })),
  };
}
