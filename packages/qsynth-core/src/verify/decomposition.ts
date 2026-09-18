/**
 * Does the Clifford+T circuit still compute what the reversible circuit computed?
 *
 * The answer is assembled from three sources, in decreasing order of strength, and the
 * report always says which one carried it. Claiming more than was checked is the one
 * failure mode a verification product cannot survive.
 *
 *   1. **By construction (always).** Each decomposition rule has been compared against
 *      the exact matrix of the gate it replaces. Since the lowering is context-free —
 *      gate in, replacement out, no peephole — equality of the parts gives equality of
 *      the whole. This alone is a proof, and it holds at every width.
 *
 *   2. **Tableau equivalence (Clifford-only circuits, any width).** When nothing in the
 *      circuit is a Toffoli or Fredkin, the decomposition is Clifford and two tableaux
 *      settle it exactly, in polynomial time, with no sampling.
 *
 *   3. **Statevector spot-check (≤ 20 qubits).** An independent end-to-end execution of
 *      the emitted gate list. It re-derives (1) the hard way on a handful of inputs, so
 *      a mistake in the *application* of a verified rule — a swapped control, an
 *      off-by-one wire — is caught even though the rule itself is correct.
 *
 * (3) is the one that earns its cost. (1) proves the table is right; only an end-to-end
 * run proves the table was used right.
 */
import type { ReversibleCircuit } from '../ir/reversible.js';
import { isClifford, tCount, twoQubitCount, type QuantumCircuit } from '../ir/quantum.js';
import { initialState, run as runReversible } from '../sim/basisState.js';
import { Statevector, MAX_STATEVECTOR_QUBITS } from '../sim/statevector.js';
import { cliffordEquivalent } from '../sim/stabilizer.js';
import { asQuantumDirect, verifyRules, type RuleVerdict } from '../lowering/reversibleToQuantum.js';
import { assignmentToBits } from '../eval/classical.js';

export type DecompositionMethod = 'rules_only' | 'tableau' | 'statevector';

export interface DecompositionEvidence {
  /** Always present: the rule table's verdict. */
  readonly rulesVerified: boolean;
  readonly rules: readonly { kind: string; gates: number; tCount: number; ok: boolean }[];
  readonly method: DecompositionMethod;
  /** Why the strongest available method was not the one used. */
  readonly methodReason: string;
  readonly qubits: number;
  readonly tCount: number;
  readonly twoQubitGates: number;
  readonly gateCount: number;
  /** Statevector only: how many input assignments were executed end to end. */
  readonly statesChecked?: number;
}

export interface DecompositionFailure {
  readonly stage: 'rules' | 'tableau' | 'statevector';
  readonly detail: string;
  /** The input assignment that reproduces it, when there is one. */
  readonly assignment?: number;
}

export interface DecompositionResult {
  readonly ok: boolean;
  readonly evidence: DecompositionEvidence;
  readonly failure?: DecompositionFailure;
}

/**
 * How many assignments to execute on the statevector. Each costs 2^qubits amplitudes
 * times the decomposed gate count, so this is the expensive end of verification and is
 * kept to a spot-check: the exhaustive claim is made at the reversible layer, where it
 * is affordable, and this only has to catch a systematic wiring mistake — which shows up
 * on the first input that exercises the gate at all.
 */
const STATEVECTOR_SAMPLES = 8;

export function checkDecomposition(
  circuit: ReversibleCircuit,
  quantum: QuantumCircuit,
  options: { readonly assignments?: readonly number[] } = {},
): DecompositionResult {
  const verdicts = verifyRules();
  const base = {
    rulesVerified: verdicts.ok,
    rules: verdicts.rules.map((r: RuleVerdict) => ({ kind: r.kind, gates: r.gates, tCount: r.tCount, ok: r.ok })),
    qubits: quantum.wires.length,
    tCount: tCount(quantum),
    twoQubitGates: twoQubitCount(quantum),
    gateCount: quantum.gates.length,
  };

  if (!verdicts.ok) {
    const broken = verdicts.rules.filter((r) => !r.ok);
    return {
      ok: false,
      evidence: { ...base, method: 'rules_only', methodReason: 'The rule table failed its own check, so nothing further was run.' },
      failure: {
        stage: 'rules',
        detail: `The decomposition rule for ${broken.map((r) => r.kind).join(', ')} does not equal the gate it replaces.`,
      },
    };
  }

  // Clifford-only: settle it completely, at any width, and skip the sampling entirely.
  if (isClifford(quantum)) {
    const reference = asQuantumDirect(circuit);
    if (reference) {
      const comparison = cliffordEquivalent(reference, quantum);
      const evidence: DecompositionEvidence = {
        ...base,
        method: 'tableau',
        methodReason:
          'The decomposition contains no T gates, so the circuit is Clifford and tableau comparison decides equivalence exactly.',
      };
      if (comparison.equivalent) return { ok: true, evidence };
      return {
        ok: false,
        evidence,
        failure: {
          stage: 'tableau',
          detail:
            `Conjugating ${comparison.difference!.generator} gives ${comparison.difference!.observed} after decomposition, ` +
            `but ${comparison.difference!.expected} before it.`,
        },
      };
    }
  }

  if (quantum.wires.length > MAX_STATEVECTOR_QUBITS) {
    return {
      ok: true,
      evidence: {
        ...base,
        method: 'rules_only',
        methodReason:
          `The circuit uses ${quantum.wires.length} qubits, past the ${MAX_STATEVECTOR_QUBITS}-qubit statevector limit, ` +
          `so equivalence rests on the verified rule table rather than on an end-to-end execution.`,
      },
    };
  }

  const assignments = pick(circuit, options.assignments);
  for (const assignment of assignments) {
    const bits = assignmentToBits(assignment, circuit.inputs.length);
    const start = initialState(circuit, bits);
    const expected = runReversible(circuit, start.slice());

    const state = Statevector.basis(quantum.wires.length, indexOf(start));
    state.run(quantum);
    const observed = state.dominantBasis();

    if (observed === null || observed !== indexOf(expected)) {
      return {
        ok: false,
        evidence: {
          ...base,
          method: 'statevector',
          methodReason: 'An end-to-end execution of the decomposed circuit disagreed with the reversible one.',
          statesChecked: assignments.length,
        },
        failure: {
          stage: 'statevector',
          assignment,
          detail:
            observed === null
              ? 'The decomposed circuit left the qubits in a superposition, so it is not the permutation the reversible circuit is.'
              : `On assignment ${assignment} the decomposed circuit produced basis state ${observed}, not ${indexOf(expected)}.`,
        },
      };
    }
  }

  return {
    ok: true,
    evidence: {
      ...base,
      method: 'statevector',
      methodReason:
        `Every rule was checked against the exact matrix of its gate, and ${assignments.length} input assignment(s) were ` +
        `additionally executed end to end on the decomposed circuit.`,
      statesChecked: assignments.length,
    },
  };
}

/** Basis index of a wire-indexed state: bit w is wire w, matching the statevector. */
function indexOf(state: Uint8Array): number {
  let index = 0;
  for (let w = 0; w < state.length; w++) if (state[w] === 1) index += 2 ** w;
  return index;
}

/**
 * Spread the spot-check over the assignments the equivalence check already planned,
 * rather than drawing fresh random ones: those are the assignments whose reversible
 * results are known good, and reusing them keeps the two checks talking about the same
 * inputs when one of them fails.
 */
function pick(circuit: ReversibleCircuit, planned: readonly number[] | undefined): readonly number[] {
  const space = 2 ** circuit.inputs.length;
  const pool = planned && planned.length > 0 ? planned : Array.from({ length: Math.min(space, STATEVECTOR_SAMPLES) }, (_, i) => i);
  if (pool.length <= STATEVECTOR_SAMPLES) return pool;
  const step = Math.floor(pool.length / STATEVECTOR_SAMPLES);
  return Array.from({ length: STATEVECTOR_SAMPLES }, (_, i) => pool[i * step]!);
}
