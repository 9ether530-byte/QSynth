/**
 * Cancel pairs of gates that undo each other.
 *
 * Every gate in this IR is an involution, so two identical gates in a row are the
 * identity. The useful part is "in a row" being read modulo commutation: the Bennett
 * lowering emits a compute block, a copy-out, and the compute block again in reverse, and
 * the pairs that can be cancelled from that shape are almost never literally adjacent —
 * they are separated by gates on wires they never touch.
 *
 * The commutation test is deliberately conservative. Two gates commute here when neither
 * writes a wire the other so much as reads:
 *
 *     targets(a) ∩ wires(b) = ∅   and   targets(b) ∩ wires(a) = ∅
 *
 * That is sufficient but not necessary. It admits the case that matters most here — gates
 * sharing only controls, since a control is not a target — and rejects some pairs that do
 * commute, such as two CNOTs onto the same wire from different controls, which are both
 * writes to that wire and yet commute because XOR does. Missing those costs cancellation
 * opportunities and nothing else, which is the direction a rule like this should be wrong
 * in: an over-eager version would be caught by the guard, but only by having the whole
 * pass thrown away.
 */
import type { Gate, ReversibleCircuit } from '../ir/reversible.js';
import { targetsOf } from '../ir/reversible.js';
import { rewriteGates, type GateRewrite } from './rewrite.js';
import type { Pass } from './types.js';

/**
 * A gate's identity for cancellation purposes, with the wire orders that do not matter
 * normalised away: a Toffoli's two controls are interchangeable, and a Fredkin's two
 * targets are interchangeable, so `ccnot(a,b,t)` must cancel against `ccnot(b,a,t)`.
 */
function signature(gate: Gate): string {
  const w = gate.wires;
  switch (gate.kind) {
    case 'x':
      return `x ${w[0]}`;
    case 'cnot':
      return `cnot ${w[0]}>${w[1]}`;
    case 'ccnot': {
      const controls = [w[0]!, w[1]!].sort((a, b) => a - b);
      return `ccnot ${controls[0]},${controls[1]}>${w[2]}`;
    }
    case 'cswap': {
      const targets = [w[1]!, w[2]!].sort((a, b) => a - b);
      return `cswap ${w[0]}>${targets[0]},${targets[1]}`;
    }
  }
}

function commutes(a: Gate, b: Gate): boolean {
  for (const target of targetsOf(a)) if (b.wires.includes(target)) return false;
  for (const target of targetsOf(b)) if (a.wires.includes(target)) return false;
  return true;
}

export const cancelInverses: Pass = {
  id: 'cancel-inverses',
  title: 'Cancel self-inverse pairs',
  rationale:
    'Every gate in the reversible IR is its own inverse, so two matching gates separated only by ' +
    'gates that commute with them can both be removed.',

  run(circuit: ReversibleCircuit): ReversibleCircuit {
    const gates = circuit.gates;
    const rewrites: GateRewrite[] = [...gates];
    const signatures = gates.map(signature);

    for (let i = 0; i < gates.length; i++) {
      if (rewrites[i] === null) continue;
      for (let j = i + 1; j < gates.length; j++) {
        // Already-cancelled gates are skipped rather than treated as blockers: a cancelled
        // pair is the identity, so it cannot stop anything from sliding past it.
        if (rewrites[j] === null) continue;
        if (signatures[i] === signatures[j]) {
          rewrites[i] = null;
          rewrites[j] = null;
          break;
        }
        if (!commutes(gates[i]!, gates[j]!)) break;
      }
    }

    return rewriteGates(circuit, rewrites);
  },
};
