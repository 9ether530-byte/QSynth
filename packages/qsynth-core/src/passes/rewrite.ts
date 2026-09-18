/**
 * The two structural edits a pass is allowed to make, in one place.
 *
 * Both of them renumber something the rest of the compiler reads — gate indices in the
 * ancilla ledger, wire indices in gates and in the input/output lists — and a pass that
 * open-coded either would be one refactor away from a ledger that points at the wrong
 * gate. Centralising them means the renumbering is written once and tested once, and a
 * new pass gets it for free.
 */
import type { AncillaRecord, Gate, ReversibleCircuit, Wire } from '../ir/reversible.js';
import { assertInvariant } from '../errors.js';

/** Per old gate: the gate to keep (possibly rewritten), or null to drop it. */
export type GateRewrite = Gate | null;

/**
 * Applies a per-gate rewrite and renumbers the ancilla ledger to match.
 *
 * The ledger's three fields are all positions in the gate list, and they are remapped by
 * counting survivors: an index becomes the number of gates that survive strictly before
 * it. For `allocatedAtGate`, which was recorded as "the length of the gate list at the
 * moment of allocation", that is exactly right.
 *
 * `uncomputedAtGate` and `releasedAtGate` point *at* a gate, and that gate may itself
 * have been dropped. The position still marks where the ancilla's value stopped being
 * live, because a pass cannot remove the gate that undid a write without the guard
 * catching it unless the write is gone too — and the guard is what makes that a fact
 * rather than a hope. What these fields stop being after optimization is a pointer to a
 * specific surviving gate, and no caller treats them as one: check 4 decides whether an
 * ancilla came back to |0⟩ by simulating, never by reading an index.
 */
export function rewriteGates(circuit: ReversibleCircuit, rewrites: readonly GateRewrite[]): ReversibleCircuit {
  assertInvariant(
    rewrites.length === circuit.gates.length,
    `rewrite plan has ${rewrites.length} entries for ${circuit.gates.length} gates`,
  );

  const gates: Gate[] = [];
  // survivorsBefore[i] = how many gates survive at an index strictly below i.
  const survivorsBefore = new Int32Array(rewrites.length + 1);
  for (let i = 0; i < rewrites.length; i++) {
    survivorsBefore[i] = gates.length;
    const gate = rewrites[i]!;
    if (gate !== null) gates.push(gate);
  }
  survivorsBefore[rewrites.length] = gates.length;

  if (gates.length === circuit.gates.length && rewrites.every((g, i) => g === circuit.gates[i])) {
    return circuit;
  }

  const at = (index: number): number => survivorsBefore[Math.min(Math.max(index, 0), rewrites.length)]!;
  const ancillas: AncillaRecord[] = circuit.ancillas.map((record) => ({
    ...record,
    allocatedAtGate: at(record.allocatedAtGate),
    uncomputedAtGate: record.uncomputedAtGate === null ? null : at(record.uncomputedAtGate),
    releasedAtGate: record.releasedAtGate === null ? null : at(record.releasedAtGate),
  }));

  return { ...circuit, gates, ancillas };
}

/**
 * Removes wires and renumbers everything that names one.
 *
 * Refuses to remove a wire a gate still references rather than emitting a circuit with a
 * dangling index: a renumbering bug that silently produced a valid-looking circuit would
 * be caught by the guard, but only after it had already been simulated against, and the
 * error it raised there would name a wrong answer instead of the actual mistake.
 */
export function dropWires(circuit: ReversibleCircuit, remove: ReadonlySet<number>): ReversibleCircuit {
  if (remove.size === 0) return circuit;

  const renumbered = new Int32Array(circuit.wires.length).fill(-1);
  const wires: Wire[] = [];
  for (const wire of circuit.wires) {
    if (remove.has(wire.index)) continue;
    renumbered[wire.index] = wires.length;
    wires.push({ ...wire, index: wires.length });
  }

  const map = (wire: number): number => {
    const next = renumbered[wire] ?? -1;
    assertInvariant(next >= 0, `wire ${wire} was removed but is still referenced`);
    return next;
  };

  return {
    ...circuit,
    wires,
    gates: circuit.gates.map((gate) => ({ ...gate, wires: gate.wires.map(map) })),
    inputs: circuit.inputs.map((input) => ({ ...input, wire: map(input.wire) })),
    outputs: circuit.outputs.map((output) => ({ ...output, wire: map(output.wire) })),
    ancillas: circuit.ancillas.filter((a) => !remove.has(a.wire)).map((a) => ({ ...a, wire: map(a.wire) })),
  };
}
