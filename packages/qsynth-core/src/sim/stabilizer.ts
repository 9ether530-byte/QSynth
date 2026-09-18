/**
 * Stabilizer (tableau) simulation of Clifford circuits — the Gottesman–Knill route.
 *
 * A Clifford circuit is fully described by how it conjugates the 2n Pauli generators
 * X₀…X_{n-1}, Z₀…Z_{n-1}. That is 2n signed Pauli strings, so the whole circuit fits in
 * O(n²) bits and each gate costs O(n) to apply — against 2ⁿ amplitudes and O(2ⁿ) per gate
 * for the statevector. It buys exactly one thing here, and it is a big one:
 *
 *   **Complete equivalence checking for Clifford circuits at any width.** Two Clifford
 *   circuits implement the same operation, up to a global phase, if and only if they
 *   conjugate every generator to the same signed Pauli — so comparing two tableaux is a
 *   decision procedure, not a sample. Circuits of X and CNOT (parity trees, linear codes,
 *   the XOR skeleton of an adder) stay Clifford however wide they get, and those are
 *   precisely the circuits a statevector cannot reach.
 *
 * There is deliberately **no measurement here.** The textbook tableau carries a
 * measurement routine, but every question this compiler asks a stabilizer simulator is
 * about equality of operations, which never needs one — and a basis state through a
 * permutation circuit is already answered faster, exactly, by `sim/basisState.ts`. Code
 * with no caller is code nobody checks.
 *
 * Row layout follows Aaronson–Gottesman: rows 0…n-1 are destabilizers (images of Xᵢ),
 * rows n…2n-1 are stabilizers (images of Zᵢ), each with an x bit and a z bit per qubit
 * plus a sign bit.
 */
import { QsynthError } from '../errors.js';
import { NON_CLIFFORD, type QuantumCircuit, type QuantumGateKind } from '../ir/quantum.js';

/** 1024 qubits is a 2 MB tableau — far past anything this compiler will emit. */
export const MAX_STABILIZER_QUBITS = 1024;

export class Tableau {
  readonly n: number;
  /** Row-major, (2n) rows × n columns. */
  private readonly x: Uint8Array;
  private readonly z: Uint8Array;
  private readonly r: Uint8Array;

  private constructor(n: number) {
    if (n > MAX_STABILIZER_QUBITS) {
      throw new QsynthError(
        'BUDGET_EXCEEDED',
        `Stabilizer simulation of ${n} qubits exceeds the limit of ${MAX_STABILIZER_QUBITS}.`,
        'Split the design into modules that are verified separately.',
        { details: { qubits: n, limit: MAX_STABILIZER_QUBITS } },
      );
    }
    this.n = n;
    this.x = new Uint8Array(2 * n * n);
    this.z = new Uint8Array(2 * n * n);
    this.r = new Uint8Array(2 * n);
  }

  /** The identity: row i holds Xᵢ for i < n, and Z_{i-n} above that. */
  static identity(n: number): Tableau {
    const tableau = new Tableau(n);
    for (let i = 0; i < n; i++) {
      tableau.x[i * n + i] = 1;
      tableau.z[(n + i) * n + i] = 1;
    }
    return tableau;
  }

  apply(kind: QuantumGateKind, wires: readonly number[]): void {
    switch (kind) {
      case 'h':
        this.hadamard(wires[0]!);
        return;
      case 's':
        this.phase(wires[0]!);
        return;
      case 'sdg':
        // S† = S³; three applications is cheaper to trust than a second update rule.
        this.phase(wires[0]!);
        this.phase(wires[0]!);
        this.phase(wires[0]!);
        return;
      case 'z':
        this.phase(wires[0]!);
        this.phase(wires[0]!);
        return;
      case 'x':
        this.hadamard(wires[0]!);
        this.phase(wires[0]!);
        this.phase(wires[0]!);
        this.hadamard(wires[0]!);
        return;
      case 'y':
        // Y = i·XZ, and the factor i cancels in conjugation, so Y acts as Z then X.
        this.apply('z', wires);
        this.apply('x', wires);
        return;
      case 'cx':
        this.cnot(wires[0]!, wires[1]!);
        return;
      case 't':
      case 'tdg':
        throw new QsynthError(
          'INTERNAL',
          'A T gate was handed to the stabilizer simulator, which can only represent Clifford operations.',
          'This is a compiler defect: the caller should have checked the circuit is Clifford first.',
          { details: { gate: kind } },
        );
    }
  }

  run(circuit: QuantumCircuit): void {
    for (const gate of circuit.gates) this.apply(gate.kind, gate.wires);
  }

  private hadamard(a: number): void {
    const { n, x, z, r } = this;
    for (let i = 0; i < 2 * n; i++) {
      const k = i * n + a;
      r[i] = r[i]! ^ (x[k]! & z[k]!);
      const t = x[k]!;
      x[k] = z[k]!;
      z[k] = t;
    }
  }

  private phase(a: number): void {
    const { n, x, z, r } = this;
    for (let i = 0; i < 2 * n; i++) {
      const k = i * n + a;
      r[i] = r[i]! ^ (x[k]! & z[k]!);
      z[k] = z[k]! ^ x[k]!;
    }
  }

  private cnot(a: number, b: number): void {
    const { n, x, z, r } = this;
    for (let i = 0; i < 2 * n; i++) {
      const ka = i * n + a;
      const kb = i * n + b;
      r[i] = r[i]! ^ (x[ka]! & z[kb]! & (x[kb]! ^ z[ka]! ^ 1));
      x[kb] = x[kb]! ^ x[ka]!;
      z[ka] = z[ka]! ^ z[kb]!;
    }
  }

  /** Every bit of the tableau, for an exact comparison between two circuits. */
  equals(other: Tableau): boolean {
    if (this.n !== other.n) return false;
    for (let i = 0; i < this.x.length; i++) {
      if (this.x[i] !== other.x[i] || this.z[i] !== other.z[i]) return false;
    }
    for (let i = 0; i < this.r.length; i++) if (this.r[i] !== other.r[i]) return false;
    return true;
  }

  /** The first row where two tableaux disagree, as readable Pauli strings. */
  firstDifference(other: Tableau): { row: number; role: 'destabilizer' | 'stabilizer'; qubit: number; expected: string; observed: string } | null {
    for (let i = 0; i < 2 * this.n; i++) {
      for (let q = 0; q < this.n; q++) {
        const k = i * this.n + q;
        if (this.x[k] === other.x[k] && this.z[k] === other.z[k]) continue;
        return {
          row: i,
          role: i < this.n ? 'destabilizer' : 'stabilizer',
          qubit: i % this.n,
          expected: this.rowString(i),
          observed: other.rowString(i),
        };
      }
      if (this.r[i] !== other.r[i]) {
        return {
          row: i,
          role: i < this.n ? 'destabilizer' : 'stabilizer',
          qubit: i % this.n,
          expected: this.rowString(i),
          observed: other.rowString(i),
        };
      }
    }
    return null;
  }

  /** e.g. `-XIZ` — the signed Pauli string a generator is mapped to. */
  rowString(row: number): string {
    const parts: string[] = [this.r[row] === 1 ? '-' : '+'];
    for (let q = 0; q < this.n; q++) {
      const k = row * this.n + q;
      const xb = this.x[k]!;
      const zb = this.z[k]!;
      parts.push(xb && zb ? 'Y' : xb ? 'X' : zb ? 'Z' : 'I');
    }
    return parts.join('');
  }
}

export interface CliffordComparison {
  readonly equivalent: boolean;
  readonly qubits: number;
  readonly difference?: {
    readonly generator: string;
    readonly expected: string;
    readonly observed: string;
  };
}

/**
 * Decide whether two Clifford circuits implement the same operation, up to global phase.
 * Complete — not sampled — and polynomial in the qubit count.
 */
export function cliffordEquivalent(a: QuantumCircuit, b: QuantumCircuit): CliffordComparison {
  for (const circuit of [a, b]) {
    const offending = circuit.gates.find((g) => NON_CLIFFORD.has(g.kind));
    if (offending) {
      throw new QsynthError(
        'INTERNAL',
        `Circuit "${circuit.name}" contains a ${offending.kind} gate and is not Clifford.`,
        'This is a compiler defect: check `isClifford` before comparing tableaux.',
        { details: { gate: offending.kind } },
      );
    }
  }

  const qubits = Math.max(a.wires.length, b.wires.length);
  const left = Tableau.identity(qubits);
  const right = Tableau.identity(qubits);
  left.run(a);
  right.run(b);

  const difference = left.firstDifference(right);
  if (!difference) return { equivalent: true, qubits };
  return {
    equivalent: false,
    qubits,
    difference: {
      generator: `${difference.role === 'destabilizer' ? 'X' : 'Z'}${difference.qubit}`,
      expected: difference.expected,
      observed: difference.observed,
    },
  };
}
