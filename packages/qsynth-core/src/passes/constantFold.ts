/**
 * Propagate known wire values forward and simplify the gates that read them.
 *
 * Ancillas and output wires start at |0⟩ and inputs start unknown, so every constant this
 * pass exploits traces back to an ancilla that has not been written yet or to a constant
 * the user wrote in their specification. There is more of that than it sounds: the
 * truth-table frontend emits constants directly, and a Boolean expression like
 * `out = a AND 0` lowers to a Toffoli whose control is provably |0⟩.
 *
 * Three simplifications, in decreasing order of value:
 *
 *   - a control known to be |0⟩ makes the gate a no-op, and it is dropped;
 *   - a control known to be |1⟩ is removed, so a Toffoli becomes a CNOT and a CNOT
 *     becomes an X — each step down the ladder is roughly seven T gates cheaper;
 *   - a Fredkin whose control is known keeps its gate but resolves the two target
 *     values, which lets the wires downstream of it stay known instead of going opaque.
 *
 * The analysis is a single forward pass with three states per wire (0, 1, unknown) and no
 * fixed point to reach, because the IR is straight-line: there are no branches and no
 * loops, so each wire's value is determined by the gates before it and nothing after.
 */
import type { Gate, ReversibleCircuit } from '../ir/reversible.js';
import { rewriteGates, type GateRewrite } from './rewrite.js';
import type { Pass } from './types.js';

type Known = 0 | 1 | null;

const flip = (value: Known): Known => (value === null ? null : value === 0 ? 1 : 0);

/** Same span and node id as the gate it replaces, so trace links survive the rewrite. */
const asGate = (from: Gate, kind: Gate['kind'], wires: readonly number[]): Gate => ({
  kind,
  wires: [...wires],
  span: from.span,
  nodeId: from.nodeId,
});

export const constantFold: Pass = {
  id: 'constant-fold',
  title: 'Fold constant controls',
  rationale:
    'Ancillas begin at |0⟩, so a gate controlled by one that has not been written yet cannot fire ' +
    'and is removed, and a control known to be |1⟩ is dropped from the gate entirely.',

  run(circuit: ReversibleCircuit): ReversibleCircuit {
    const known: Known[] = circuit.wires.map((wire) => (wire.role === 'input' ? null : 0));
    const rewrites: GateRewrite[] = [];

    for (const gate of circuit.gates) {
      const w = gate.wires;
      switch (gate.kind) {
        case 'x': {
          const target = w[0]!;
          known[target] = flip(known[target]!);
          rewrites.push(gate);
          break;
        }

        case 'cnot': {
          const control = w[0]!;
          const target = w[1]!;
          if (known[control] === 0) {
            rewrites.push(null);
          } else if (known[control] === 1) {
            known[target] = flip(known[target]!);
            rewrites.push(asGate(gate, 'x', [target]));
          } else {
            known[target] = null;
            rewrites.push(gate);
          }
          break;
        }

        case 'ccnot': {
          const a = w[0]!;
          const b = w[1]!;
          const target = w[2]!;
          if (known[a] === 0 || known[b] === 0) {
            rewrites.push(null);
          } else if (known[a] === 1 && known[b] === 1) {
            known[target] = flip(known[target]!);
            rewrites.push(asGate(gate, 'x', [target]));
          } else if (known[a] === 1 || known[b] === 1) {
            // The surviving control is the unknown one; the target follows it, so it
            // becomes unknown too.
            known[target] = null;
            rewrites.push(asGate(gate, 'cnot', [known[a] === 1 ? b : a, target]));
          } else {
            known[target] = null;
            rewrites.push(gate);
          }
          break;
        }

        case 'cswap': {
          const control = w[0]!;
          const a = w[1]!;
          const b = w[2]!;
          if (known[control] === 0) {
            rewrites.push(null);
          } else if (known[control] === 1) {
            // The swap definitely happens. There is no unconditional SWAP in this IR, so
            // the gate stays — but the analysis follows the values across it.
            const held = known[a]!;
            known[a] = known[b]!;
            known[b] = held;
            rewrites.push(gate);
          } else {
            known[a] = null;
            known[b] = null;
            rewrites.push(gate);
          }
          break;
        }
      }
    }

    return rewriteGates(circuit, rewrites);
  },
};
