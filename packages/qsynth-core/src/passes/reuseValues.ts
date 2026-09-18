/**
 * Replace a gate with the cheapest gate that has the same effect, using the values the
 * circuit already holds.
 *
 * This is the pass that earns the pipeline its keep, and the reason is a property of
 * Bennett form rather than of any particular specification. Lowering allocates a fresh
 * ancilla per operation, so a sub-expression written twice is *computed* twice — `out = (a
 * AND b) XOR c` alongside `carry = a AND b` emits the Toffoli for `a AND b` four times
 * across the compute and uncompute halves, at seven T gates each. The second copy is not
 * dead code and no peephole rule sees it: the two Toffolis write different wires and are
 * separated by gates that read both.
 *
 * What makes them removable is that some wire already holds `a AND b` when the duplicate
 * fires, so the duplicate can be a CNOT from that wire instead — one gate, no T gates at
 * all.
 *
 * **Why this is exact rather than heuristic.** Every wire in a reversible circuit holds a
 * deterministic function of the input bits: ancillas and outputs start at |0⟩, inputs hold
 * themselves, and each gate is a total function of what came before. At `n` inputs that
 * function is fully described by its 2^n-bit truth table, so this pass carries one bitmask
 * per wire and updates it gate by gate. Two wires hold the same value exactly when their
 * masks are equal — not "probably", not "on the assignments we sampled". The rewrite is
 * therefore a proof, and the equivalence guard downstream is a second opinion rather than
 * the only one.
 *
 * The bitmask is why the pass declines above `EXHAUSTIVE_INPUT_LIMIT`: past that point the
 * table stops fitting in a request, and a sampled version of it would turn a proof into a
 * guess. Declining is the right failure — the circuit is merely un-optimized, which is the
 * one thing a pass is allowed to leave behind.
 *
 * Four rewrites, all of them strict reductions in the gate-cost table:
 *
 *   - the gate's effect is the zero function — it can never fire, so it is dropped;
 *   - the effect is the constant one — it is an X;
 *   - the effect is a value some wire already holds — it is a CNOT from that wire;
 *   - a Fredkin whose two targets always agree, or whose control is never set, does
 *     nothing and is dropped.
 *
 * A gate is only rewritten when the replacement is strictly cheaper, so the pass never
 * churns a CNOT into a different CNOT.
 */
import { EXHAUSTIVE_INPUT_LIMIT } from '../ir/classical.js';
import type { Gate, GateKind, ReversibleCircuit } from '../ir/reversible.js';
import { rewriteGates, type GateRewrite } from './rewrite.js';
import type { Pass } from './types.js';

/** Cheapest first. A rewrite is only made when it moves strictly down this ladder. */
const COST_RANK: Record<GateKind, number> = { x: 1, cnot: 2, ccnot: 3, cswap: 3 };

/** One wire's value, as a truth table over the circuit's inputs, packed 32 bits per word. */
type Mask = Uint32Array;

class ValueTable {
  private readonly words: number;
  private readonly values: Mask[];
  /**
   * The constant-one function. Fewer than 32 rows leaves spare bits in the last word, and
   * they are held at zero throughout rather than left as don't-cares: two wires that agree
   * on every real row must compare equal, and padding that differed between them would
   * silently cost a rewrite.
   */
  private readonly ones: Mask;
  /** Value key → the wires currently holding it. Lets a lookup be a hash, not a scan. */
  private readonly holders = new Map<string, Set<number>>();
  private readonly keys: string[];

  constructor(circuit: ReversibleCircuit, inputCount: number) {
    const rows = 2 ** inputCount;
    this.words = Math.max(1, Math.ceil(rows / 32));
    this.values = circuit.wires.map(() => new Uint32Array(this.words));

    this.ones = new Uint32Array(this.words);
    for (let row = 0; row < rows; row++) this.ones[row >>> 5]! |= 1 << (row & 31);

    // Input k holds bit k of the assignment index; everything else starts at |0⟩.
    circuit.inputs.forEach((input, k) => {
      const mask = this.values[input.wire]!;
      for (let row = 0; row < rows; row++) {
        if ((row >> k) & 1) mask[row >>> 5]! |= 1 << (row & 31);
      }
    });

    this.keys = this.values.map((mask) => ValueTable.key(mask));
    this.keys.forEach((key, wire) => this.index(key, wire));
  }

  /** The constant-one function, for an X gate's effect. */
  allOnes(): Mask {
    return this.ones;
  }

  private static key(mask: Mask): string {
    let text = '';
    for (const word of mask) text += word.toString(36) + '.';
    return text;
  }

  private index(key: string, wire: number): void {
    const set = this.holders.get(key);
    if (set) set.add(wire);
    else this.holders.set(key, new Set([wire]));
  }

  valueOf(wire: number): Mask {
    return this.values[wire]!;
  }

  scratch(): Mask {
    return new Uint32Array(this.words);
  }

  isZero(mask: Mask): boolean {
    for (const word of mask) if (word !== 0) return false;
    return true;
  }

  isOne(mask: Mask): boolean {
    return this.equal(mask, this.ones);
  }

  equal(a: Mask, b: Mask): boolean {
    for (let i = 0; i < this.words; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Any wire other than `exclude` whose value is `mask`, or -1. */
  holderOf(mask: Mask, exclude: number): number {
    const set = this.holders.get(ValueTable.key(mask));
    if (!set) return -1;
    for (const wire of set) if (wire !== exclude) return wire;
    return -1;
  }

  /** `wire ^= delta`, keeping the index current. */
  xorInto(wire: number, delta: Mask): void {
    const value = this.values[wire]!;
    for (let i = 0; i < this.words; i++) value[i]! ^= delta[i]!;
    this.reindex(wire);
  }

  private reindex(wire: number): void {
    this.holders.get(this.keys[wire]!)?.delete(wire);
    const key = ValueTable.key(this.values[wire]!);
    this.keys[wire] = key;
    this.index(key, wire);
  }
}

/** Same span and node id as the gate it replaces, so trace links survive the rewrite. */
const asGate = (from: Gate, kind: GateKind, wires: readonly number[]): Gate => ({
  kind,
  wires: [...wires],
  span: from.span,
  nodeId: from.nodeId,
});

export const reuseValues: Pass = {
  id: 'reuse-values',
  title: 'Reuse values already on the wires',
  rationale:
    'A gate whose effect is a value some other wire already holds is a CNOT from that wire, which ' +
    'turns a seven-T Toffoli into a single Clifford gate.',

  run(circuit: ReversibleCircuit): ReversibleCircuit {
    const inputCount = circuit.inputs.length;
    // Above the limit the truth table stops being affordable, and a sampled substitute
    // would make this a guess instead of a proof. Declining leaves a correct circuit.
    if (inputCount > EXHAUSTIVE_INPUT_LIMIT) return circuit;

    const table = new ValueTable(circuit, inputCount);
    const rewrites: GateRewrite[] = [];
    const delta = table.scratch();

    for (const gate of circuit.gates) {
      const w = gate.wires;

      if (gate.kind === 'cswap') {
        const control = table.valueOf(w[0]!);
        const a = table.valueOf(w[1]!);
        const b = table.valueOf(w[2]!);
        // The swap moves nothing when it never fires, or when both targets always agree.
        if (table.isZero(control) || table.equal(a, b)) {
          rewrites.push(null);
          continue;
        }
        // a' = a ^ (control · (a ^ b)), and symmetrically for b.
        const swing = table.scratch();
        for (let i = 0; i < swing.length; i++) swing[i] = control[i]! & (a[i]! ^ b[i]!);
        rewrites.push(gate);
        table.xorInto(w[1]!, swing);
        table.xorInto(w[2]!, swing);
        continue;
      }

      const target = w[w.length - 1]!;
      switch (gate.kind) {
        case 'x':
          delta.set(table.allOnes());
          break;
        case 'cnot':
          delta.set(table.valueOf(w[0]!));
          break;
        case 'ccnot': {
          const a = table.valueOf(w[0]!);
          const b = table.valueOf(w[1]!);
          for (let i = 0; i < delta.length; i++) delta[i] = a[i]! & b[i]!;
          break;
        }
      }

      const rank = COST_RANK[gate.kind];
      if (table.isZero(delta)) {
        rewrites.push(null);
        continue; // The target is unchanged, so there is nothing to record.
      }
      if (table.isOne(delta) && rank > COST_RANK.x) {
        rewrites.push(asGate(gate, 'x', [target]));
      } else if (rank > COST_RANK.cnot) {
        const source = table.holderOf(delta, target);
        rewrites.push(source >= 0 ? asGate(gate, 'cnot', [source, target]) : gate);
      } else {
        rewrites.push(gate);
      }
      table.xorInto(target, delta);
    }

    return rewriteGates(circuit, rewrites);
  },
};
