/**
 * Dense statevector simulation of a Clifford+T circuit.
 *
 * Cost is 2^qubits complex amplitudes and one pass per gate, so this is the *expensive*
 * simulator and it is used sparingly: to extract the exact unitary of a decomposition
 * rule (3 qubits — an 8×8 matrix), and as a sampled cross-check on whole circuits small
 * enough to afford it. The bulk of verification happens at the reversible layer, where a
 * basis state is a bit vector and nothing has to be allocated at all.
 *
 * Amplitudes live in two flat `Float64Array`s rather than an array of objects: a 20-qubit
 * state is 2²⁰ amplitudes, and object-per-amplitude would spend more time on allocation
 * than on arithmetic.
 *
 * **Qubit ordering.** Bit `w` of a basis index is the value of qubit `w`, so q[0] is the
 * least significant bit. This is the OpenQASM and Qiskit convention; choosing the other
 * one would make every amplitude comparison against an external tool silently wrong.
 */
import { QsynthError } from '../errors.js';
import type { QuantumCircuit, QuantumGateKind } from '../ir/quantum.js';

/**
 * 2²⁰ amplitudes is 16 MB across the two arrays — affordable inside the Lambda. The limit
 * is enforced rather than merely documented, because the failure mode above it is an
 * out-of-memory kill with no error body, which tells the user nothing.
 */
export const MAX_STATEVECTOR_QUBITS = 20;

const SQRT1_2 = Math.SQRT1_2;

export interface Amplitude {
  readonly re: number;
  readonly im: number;
}

export class Statevector {
  readonly qubits: number;
  readonly re: Float64Array;
  readonly im: Float64Array;

  private constructor(qubits: number) {
    if (qubits > MAX_STATEVECTOR_QUBITS) {
      throw new QsynthError(
        'BUDGET_EXCEEDED',
        `Statevector simulation needs 2^${qubits} amplitudes; the limit is 2^${MAX_STATEVECTOR_QUBITS}.`,
        'Verification of wider circuits runs at the reversible layer, which does not build a statevector.',
        { details: { qubits, limit: MAX_STATEVECTOR_QUBITS } },
      );
    }
    this.qubits = qubits;
    this.re = new Float64Array(1 << qubits);
    this.im = new Float64Array(1 << qubits);
  }

  /** |index⟩ — a computational basis state. */
  static basis(qubits: number, index: number): Statevector {
    const state = new Statevector(qubits);
    state.re[index] = 1;
    return state;
  }

  get size(): number {
    return this.re.length;
  }

  amplitude(index: number): Amplitude {
    return { re: this.re[index]!, im: this.im[index]! };
  }

  probability(index: number): number {
    const re = this.re[index]!;
    const im = this.im[index]!;
    return re * re + im * im;
  }

  /** The basis index carrying (essentially) all the probability, or null if none does. */
  dominantBasis(tolerance = 1e-9): number | null {
    for (let i = 0; i < this.re.length; i++) {
      if (this.probability(i) > 1 - tolerance) return i;
    }
    return null;
  }

  apply(kind: QuantumGateKind, wires: readonly number[]): void {
    if (kind === 'cx') {
      this.applyCx(wires[0]!, wires[1]!);
      return;
    }
    this.applySingle(kind, wires[0]!);
  }

  run(circuit: QuantumCircuit): void {
    for (const gate of circuit.gates) this.apply(gate.kind, gate.wires);
  }

  /**
   * Single-qubit gates are split into three shapes rather than run through one general
   * 2×2 multiply. X is a swap, the diagonal gates touch only the |1⟩ half, and only H
   * actually mixes amplitudes — writing them separately keeps the common cases free of
   * multiplications by zero.
   */
  private applySingle(kind: QuantumGateKind, qubit: number): void {
    const stride = 1 << qubit;
    const { re, im } = this;

    for (let base = 0; base < re.length; base += stride << 1) {
      for (let offset = 0; offset < stride; offset++) {
        const i0 = base + offset;
        const i1 = i0 + stride;

        switch (kind) {
          case 'x': {
            const r = re[i0]!, m = im[i0]!;
            re[i0] = re[i1]!; im[i0] = im[i1]!;
            re[i1] = r; im[i1] = m;
            break;
          }
          case 'y': {
            // |0⟩ → i|1⟩, |1⟩ → -i|0⟩
            const r0 = re[i0]!, m0 = im[i0]!, r1 = re[i1]!, m1 = im[i1]!;
            re[i0] = m1; im[i0] = -r1;
            re[i1] = -m0; im[i1] = r0;
            break;
          }
          case 'z': {
            re[i1] = -re[i1]!; im[i1] = -im[i1]!;
            break;
          }
          case 's': {
            const r = re[i1]!;
            re[i1] = -im[i1]!; im[i1] = r;
            break;
          }
          case 'sdg': {
            const r = re[i1]!;
            re[i1] = im[i1]!; im[i1] = -r;
            break;
          }
          case 't': {
            const r = re[i1]!, m = im[i1]!;
            re[i1] = SQRT1_2 * (r - m); im[i1] = SQRT1_2 * (r + m);
            break;
          }
          case 'tdg': {
            const r = re[i1]!, m = im[i1]!;
            re[i1] = SQRT1_2 * (r + m); im[i1] = SQRT1_2 * (m - r);
            break;
          }
          case 'h': {
            const r0 = re[i0]!, m0 = im[i0]!, r1 = re[i1]!, m1 = im[i1]!;
            re[i0] = SQRT1_2 * (r0 + r1); im[i0] = SQRT1_2 * (m0 + m1);
            re[i1] = SQRT1_2 * (r0 - r1); im[i1] = SQRT1_2 * (m0 - m1);
            break;
          }
          case 'cx':
            break;
        }
      }
    }
  }

  private applyCx(control: number, target: number): void {
    const cBit = 1 << control;
    const tBit = 1 << target;
    const { re, im } = this;
    for (let i = 0; i < re.length; i++) {
      // Visit each swapped pair once: only from the member whose target bit is 0.
      if ((i & cBit) === 0 || (i & tBit) !== 0) continue;
      const j = i | tBit;
      const r = re[i]!, m = im[i]!;
      re[i] = re[j]!; im[i] = im[j]!;
      re[j] = r; im[j] = m;
    }
  }
}

/**
 * The full unitary of a circuit, column by column: column `k` is the circuit applied to
 * |k⟩. Exponential in both time and space, so it is for the small fixed matrices of the
 * decomposition rules — never for a user's circuit.
 */
export const MAX_UNITARY_QUBITS = 6;

export interface Unitary {
  readonly qubits: number;
  readonly dim: number;
  /** Column-major: element (row, col) is at `col * dim + row`. */
  readonly re: Float64Array;
  readonly im: Float64Array;
}

export function circuitUnitary(qubits: number, gates: readonly { kind: QuantumGateKind; wires: readonly number[] }[]): Unitary {
  if (qubits > MAX_UNITARY_QUBITS) {
    throw new QsynthError(
      'BUDGET_EXCEEDED',
      `Building a unitary needs a 2^${qubits} × 2^${qubits} matrix; the limit is ${MAX_UNITARY_QUBITS} qubits.`,
      'Compare circuits by simulating basis states instead of by materialising the matrix.',
      { details: { qubits, limit: MAX_UNITARY_QUBITS } },
    );
  }
  const dim = 1 << qubits;
  const re = new Float64Array(dim * dim);
  const im = new Float64Array(dim * dim);
  for (let col = 0; col < dim; col++) {
    const state = Statevector.basis(qubits, col);
    for (const gate of gates) state.apply(gate.kind, gate.wires);
    re.set(state.re, col * dim);
    im.set(state.im, col * dim);
  }
  return { qubits, dim, re, im };
}

export interface UnitaryDifference {
  readonly row: number;
  readonly col: number;
  readonly expected: Amplitude;
  readonly observed: Amplitude;
}

/**
 * Equality up to a global phase — the only kind of equality that means anything here.
 * A circuit differing from its target by an overall factor e^{iφ} is physically the
 * same circuit: no measurement can distinguish them, and demanding exact equality would
 * reject correct decompositions for a phase convention.
 *
 * The phase is read off one entry and then required to hold for every entry, so a
 * *relative* phase error — which is a real bug — still fails.
 *
 * The anchor is the **largest-magnitude** entry of `expected`, not the first one above a
 * fixed threshold. A threshold is a trap here: a Hadamard-heavy n-qubit unitary spreads
 * its amplitude so every entry has magnitude 2^{-n/2}, which falls under any fixed cutoff
 * as n grows, and a comparison that finds no anchor has to decide what to return. An
 * earlier version returned "equal", which made this function report H⊗H⊗H as the
 * identity — silently turning the compiler's proof obligation into a no-op at exactly the
 * widths where it matters. Every unitary has an entry of magnitude at least 2^{-n/2} > 0,
 * so a maximum always exists, and "no anchor" now means the matrix is zero, which is not
 * a unitary and is reported as a difference rather than a pass.
 */
export function differsUpToGlobalPhase(
  expected: Unitary,
  observed: Unitary,
  tolerance = 1e-9,
): UnitaryDifference | null {
  if (expected.dim !== observed.dim) {
    return {
      row: -1,
      col: -1,
      expected: { re: expected.dim, im: 0 },
      observed: { re: observed.dim, im: 0 },
    };
  }

  let anchor = -1;
  let best = tolerance * tolerance;
  for (let i = 0; i < expected.re.length; i++) {
    const mag = expected.re[i]! * expected.re[i]! + expected.im[i]! * expected.im[i]!;
    if (mag > best) {
      best = mag;
      anchor = i;
    }
  }
  if (anchor < 0) {
    // `expected` is the zero matrix: not a unitary, and nothing to take a phase from.
    return { row: 0, col: 0, expected: { re: 0, im: 0 }, observed: { re: observed.re[0]!, im: observed.im[0]! } };
  }

  // phase = observed / expected at the anchor.
  const er0 = expected.re[anchor]!, ei0 = expected.im[anchor]!;
  const or0 = observed.re[anchor]!, oi0 = observed.im[anchor]!;
  const phaseRe = (or0 * er0 + oi0 * ei0) / best;
  const phaseIm = (oi0 * er0 - or0 * ei0) / best;

  for (let i = 0; i < expected.re.length; i++) {
    const er = expected.re[i]!, ei = expected.im[i]!;
    const wantRe = er * phaseRe - ei * phaseIm;
    const wantIm = er * phaseIm + ei * phaseRe;
    if (Math.abs(wantRe - observed.re[i]!) > tolerance || Math.abs(wantIm - observed.im[i]!) > tolerance) {
      return {
        row: i % expected.dim,
        col: Math.floor(i / expected.dim),
        expected: { re: wantRe, im: wantIm },
        observed: { re: observed.re[i]!, im: observed.im[i]! },
      };
    }
  }
  return null;
}

/** A permutation matrix as a unitary, from `image[k] = the basis state |k⟩ maps to`. */
export function permutationUnitary(qubits: number, image: readonly number[]): Unitary {
  const dim = 1 << qubits;
  const re = new Float64Array(dim * dim);
  const im = new Float64Array(dim * dim);
  for (let col = 0; col < dim; col++) re[col * dim + image[col]!] = 1;
  return { qubits, dim, re, im };
}
