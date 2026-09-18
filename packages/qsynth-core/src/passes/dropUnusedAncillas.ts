/**
 * Remove ancilla wires that no gate touches.
 *
 * On its own this pass would almost never fire — lowering allocates an ancilla because it
 * is about to write to it. It earns its place after the other two: cancelling a pair of
 * gates or folding away a constant control can leave an ancilla with nothing on it at
 * all, and an untouched wire is still a qubit in every resource figure and every line of
 * the emitted QASM.
 *
 * Only ancillas are eligible. Input and output wires are the circuit's interface and are
 * named in the specification, so an unused one is a fact about the user's design that the
 * compiler has no business hiding — `out = a` genuinely does not read `b`, and silently
 * dropping `b` would change the shape the report and the QASM declare.
 */
import type { ReversibleCircuit } from '../ir/reversible.js';
import { dropWires } from './rewrite.js';
import type { Pass } from './types.js';

export const dropUnusedAncillas: Pass = {
  id: 'drop-unused-ancillas',
  title: 'Drop untouched ancillas',
  rationale:
    'An ancilla no gate references holds |0⟩ for the whole circuit, so removing it lowers the qubit ' +
    'count without changing what the circuit computes.',

  run(circuit: ReversibleCircuit): ReversibleCircuit {
    const touched = new Set<number>();
    for (const gate of circuit.gates) for (const wire of gate.wires) touched.add(wire);

    const remove = new Set<number>();
    for (const wire of circuit.wires) {
      if (wire.role === 'ancilla' && !touched.has(wire.index)) remove.add(wire.index);
    }

    return dropWires(circuit, remove);
  },
};
