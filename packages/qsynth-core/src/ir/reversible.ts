/**
 * Reversible IR — a circuit over NOT, CNOT, Toffoli and Fredkin.
 *
 * Every gate in this set is its own inverse and permutes computational basis states.
 * Two consequences the rest of the compiler leans on heavily:
 *
 *   - the inverse of a circuit is the same gate list, reversed. Uncomputation is
 *     therefore structural, not a search problem.
 *   - simulating one basis state costs one pass over the gates with no arithmetic.
 *     Exhaustive equivalence at 12 inputs is 4096 such passes, which is why the
 *     verification gate can be hard without being slow.
 *
 * Wires are partitioned by role. Inputs are never written to, so an input wire still
 * holds its original value at circuit end — the Bennett form the checks assume.
 */
import type { Span } from '../errors.js';
import { assertInvariant } from '../errors.js';

export type GateKind = 'x' | 'cnot' | 'ccnot' | 'cswap';

/** Wire counts per gate kind. Controls come first; targets last. */
export const GATE_ARITY: Record<GateKind, number> = { x: 1, cnot: 2, ccnot: 3, cswap: 3 };

/** Two-qubit-or-larger gates, for the resource estimate. */
export const MULTI_QUBIT: ReadonlySet<GateKind> = new Set<GateKind>(['cnot', 'ccnot', 'cswap']);

export interface Gate {
  readonly kind: GateKind;
  /**
   * x:     [target]
   * cnot:  [control, target]
   * ccnot: [control, control, target]
   * cswap: [control, targetA, targetB]
   */
  readonly wires: readonly number[];
  readonly span?: Span;
  /** Classical IR node this gate implements, for trace linking. */
  readonly nodeId?: number;
}

export type WireRole = 'input' | 'ancilla' | 'output';

export interface Wire {
  readonly index: number;
  readonly role: WireRole;
  readonly name: string;
}

/**
 * One ancilla's whole life (FR-2). `uncomputedAtGate` is the index of the gate that
 * returned it to |0⟩; a null there after lowering means the ancilla is garbage, which
 * check 4 reports per-ancilla rather than as a single circuit-level verdict.
 */
export interface AncillaRecord {
  readonly wire: number;
  readonly purpose: string;
  readonly nodeId: number | undefined;
  readonly allocatedAtGate: number;
  uncomputedAtGate: number | null;
  releasedAtGate: number | null;
  readonly span?: Span;
}

export interface ReversibleCircuit {
  readonly name: string;
  readonly wires: readonly Wire[];
  readonly gates: readonly Gate[];
  readonly inputs: readonly { readonly name: string; readonly wire: number }[];
  readonly outputs: readonly { readonly name: string; readonly wire: number }[];
  readonly ancillas: readonly AncillaRecord[];
}

export class CircuitBuilder {
  private readonly wires: Wire[] = [];
  private readonly gates: Gate[] = [];
  private readonly inputs: { name: string; wire: number }[] = [];
  private readonly outputs: { name: string; wire: number }[] = [];
  private readonly ancillas: AncillaRecord[] = [];

  constructor(private readonly name: string) {}

  get gateCount(): number {
    return this.gates.length;
  }

  get wireCount(): number {
    return this.wires.length;
  }

  addInput(name: string): number {
    const index = this.wires.length;
    this.wires.push({ index, role: 'input', name });
    this.inputs.push({ name, wire: index });
    return index;
  }

  addOutput(name: string): number {
    const index = this.wires.length;
    this.wires.push({ index, role: 'output', name });
    this.outputs.push({ name, wire: index });
    return index;
  }

  allocateAncilla(purpose: string, nodeId?: number, span?: Span): AncillaRecord {
    const index = this.wires.length;
    this.wires.push({ index, role: 'ancilla', name: `anc${this.ancillas.length}` });
    const record: AncillaRecord = {
      wire: index,
      purpose,
      nodeId,
      allocatedAtGate: this.gates.length,
      uncomputedAtGate: null,
      releasedAtGate: null,
      span,
    };
    this.ancillas.push(record);
    return record;
  }

  emit(kind: GateKind, wires: readonly number[], opts: { span?: Span; nodeId?: number } = {}): number {
    assertInvariant(wires.length === GATE_ARITY[kind], `${kind} takes ${GATE_ARITY[kind]} wires, got ${wires.length}`);
    assertInvariant(new Set(wires).size === wires.length, `${kind} names the same wire twice`);
    for (const w of wires) assertInvariant(w >= 0 && w < this.wires.length, `gate references undeclared wire ${w}`);
    const index = this.gates.length;
    this.gates.push({ kind, wires: [...wires], span: opts.span, nodeId: opts.nodeId });
    return index;
  }

  /** Appends the inverse of gates `[from, to)` — the same gates in reverse order. */
  emitInverseOf(from: number, to: number): void {
    for (let i = to - 1; i >= from; i--) {
      const gate = this.gates[i]!;
      this.gates.push({ kind: gate.kind, wires: gate.wires, span: gate.span, nodeId: gate.nodeId });
    }
  }

  build(): ReversibleCircuit {
    return {
      name: this.name,
      wires: [...this.wires],
      gates: [...this.gates],
      inputs: [...this.inputs],
      outputs: [...this.outputs],
      ancillas: this.ancillas.map((a) => ({ ...a })),
    };
  }
}

/**
 * The wires a gate can *write* to. Controls are excluded: a wire used only as a control
 * comes out of the gate holding exactly what it went in with, which is what lets a
 * constant ancilla be read by a Toffoli without counting as dirtied.
 */
export function targetsOf(gate: Gate): readonly number[] {
  return gate.kind === 'cswap' ? gate.wires.slice(1) : gate.wires.slice(-1);
}

/** The inverse circuit: same wires, gates reversed. Used by the reversibility check. */
export function invert(circuit: ReversibleCircuit): ReversibleCircuit {
  return { ...circuit, gates: [...circuit.gates].reverse() };
}

/**
 * Circuit depth: the longest chain of gates that must run in sequence. Gates acting on
 * disjoint wires share a layer, so this is the usual greedy as-soon-as-possible packing.
 */
export function depth(circuit: ReversibleCircuit): number {
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
