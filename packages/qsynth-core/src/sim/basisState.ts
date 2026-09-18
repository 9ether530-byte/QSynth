/**
 * Basis-state simulator for the Reversible IR — the workhorse of the verification gate.
 *
 * Every gate here permutes computational basis states, so a basis state in is a basis
 * state out and the whole "simulation" is one pass of bit operations over the gate list.
 * No amplitudes, no floating point, no numerical tolerance: the results are exact
 * integers, and equivalence failures are therefore genuine failures rather than
 * accumulated rounding.
 *
 * Cost is O(wires + gates) per run. Exhaustive equivalence over 12 inputs is 4096 runs,
 * which is why check 2 can be exhaustive inside a request timeout — the thing that would
 * be expensive (2^qubits amplitudes) is never built.
 */
import type { Gate, ReversibleCircuit } from '../ir/reversible.js';
import { assertInvariant } from '../errors.js';
import type { Bit } from '../eval/classical.js';

export type BasisState = Uint8Array;

/** A zero state wide enough for `circuit`. */
export function zeroState(circuit: ReversibleCircuit): BasisState {
  return new Uint8Array(circuit.wires.length);
}

/**
 * Initial state for one input assignment: inputs take their bits, every ancilla and
 * output starts at |0⟩. Starting ancillas anywhere else would be simulating a machine
 * we do not have.
 */
export function initialState(circuit: ReversibleCircuit, inputBits: readonly Bit[]): BasisState {
  assertInvariant(
    inputBits.length === circuit.inputs.length,
    `circuit has ${circuit.inputs.length} inputs, got ${inputBits.length} bits`,
  );
  const state = zeroState(circuit);
  for (let i = 0; i < inputBits.length; i++) state[circuit.inputs[i]!.wire] = inputBits[i]!;
  return state;
}

/** Applies one gate in place. Each of these is its own inverse. */
export function applyGate(state: BasisState, gate: Gate): void {
  const w = gate.wires;
  switch (gate.kind) {
    case 'x': {
      const t = w[0]!;
      state[t] = state[t]! ^ 1;
      break;
    }
    case 'cnot': {
      const t = w[1]!;
      if (state[w[0]!] === 1) state[t] = state[t]! ^ 1;
      break;
    }
    case 'ccnot': {
      const t = w[2]!;
      if (state[w[0]!] === 1 && state[w[1]!] === 1) state[t] = state[t]! ^ 1;
      break;
    }
    case 'cswap': {
      if (state[w[0]!] === 1) {
        const a = w[1]!;
        const b = w[2]!;
        const tmp = state[a]!;
        state[a] = state[b]!;
        state[b] = tmp;
      }
      break;
    }
  }
}

/** Runs the whole circuit in place. */
export function run(circuit: ReversibleCircuit, state: BasisState): BasisState {
  for (const gate of circuit.gates) applyGate(state, gate);
  return state;
}

/** Runs gates `[from, to)` in place — used to inspect the state mid-circuit. */
export function runRange(circuit: ReversibleCircuit, state: BasisState, from: number, to: number): BasisState {
  for (let i = from; i < to; i++) applyGate(state, circuit.gates[i]!);
  return state;
}

export interface SimulationResult {
  readonly state: BasisState;
  /** Output wire values in declaration order. */
  readonly outputs: Bit[];
  /** Input wire values at circuit end — must equal the inputs for a Bennett circuit. */
  readonly inputsAtEnd: Bit[];
  /** Ancilla wire values at circuit end — must all be 0 (check 4). */
  readonly ancillasAtEnd: Bit[];
}

export function simulate(circuit: ReversibleCircuit, inputBits: readonly Bit[]): SimulationResult {
  const state = run(circuit, initialState(circuit, inputBits));
  return {
    state,
    outputs: circuit.outputs.map((o) => state[o.wire] as Bit),
    inputsAtEnd: circuit.inputs.map((i) => state[i.wire] as Bit),
    ancillasAtEnd: circuit.ancillas.map((a) => state[a.wire] as Bit),
  };
}

/**
 * Reads named outputs out of a finished state. Output names carry the `assert:` prefix
 * for assertion wires; callers that want only real outputs filter on that.
 */
export function outputsByName(circuit: ReversibleCircuit, state: BasisState): Record<string, Bit> {
  const values: Record<string, Bit> = {};
  for (const output of circuit.outputs) values[output.name] = state[output.wire] as Bit;
  return values;
}

/**
 * The permutation the circuit induces on *all* wires, as an array of length 2^wires.
 * Exponential in wire count, so it is for tests and small proofs only — the checks use
 * per-assignment simulation instead. Refuses above 16 wires rather than allocating 4 GB.
 */
export function permutation(circuit: ReversibleCircuit): Uint32Array {
  const n = circuit.wires.length;
  assertInvariant(n <= 16, `permutation() is exponential; ${n} wires is too many`);
  const size = 1 << n;
  const table = new Uint32Array(size);
  const state = new Uint8Array(n);
  for (let value = 0; value < size; value++) {
    for (let w = 0; w < n; w++) state[w] = (value >> w) & 1;
    run(circuit, state);
    let out = 0;
    for (let w = 0; w < n; w++) if (state[w] === 1) out |= 1 << w;
    table[value] = out;
  }
  return table;
}
