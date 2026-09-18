/**
 * The golden corpus: the circuits QSYNTH is expected to get right, each paired with an
 * *independent* reference implementation written in plain TypeScript.
 *
 * The reference matters more than the snapshot. A QASM snapshot only proves the output
 * stopped changing; `reference` proves it was right in the first place, because it is
 * written from the arithmetic rather than derived from the compiler. Golden, property and
 * reproducibility suites all draw from this one list, so adding a circuit here extends all
 * three at once.
 */
import type { Bit } from '@qsynth/core';
import type { SpecKind } from '@qsynth/core';

export interface CorpusEntry {
  readonly name: string;
  readonly kind: SpecKind;
  /** What the circuit is for, in one line — reproduced in the golden file header. */
  readonly purpose: string;
  readonly source: string;
  readonly inputs: readonly string[];
  /** Independent model: input bits in declaration order → output name → bit. */
  readonly reference: (bits: readonly Bit[]) => Record<string, Bit>;
}

const bit = (value: boolean | number): Bit => ((value ? 1 : 0) as Bit);

export const CORPUS: readonly CorpusEntry[] = [
  {
    name: 'half_adder',
    kind: 'boolean',
    purpose: 'One-bit addition: sum and carry of two bits.',
    source: ['in a, b', 'sum = a XOR b', 'carry = a AND b'].join('\n'),
    inputs: ['a', 'b'],
    reference: ([a, b]) => ({ sum: bit(a! ^ b!), carry: bit(a! & b!) }),
  },
  {
    name: 'full_adder',
    kind: 'truthtable',
    purpose: 'One-bit addition with carry-in, given as a truth table.',
    source: [
      'a b cin | sum cout',
      '0 0 0 | 0 0',
      '0 0 1 | 1 0',
      '0 1 0 | 1 0',
      '0 1 1 | 0 1',
      '1 0 0 | 1 0',
      '1 0 1 | 0 1',
      '1 1 0 | 0 1',
      '1 1 1 | 1 1',
    ].join('\n'),
    inputs: ['a', 'b', 'cin'],
    reference: ([a, b, cin]) => {
      const total = a! + b! + cin!;
      return { sum: bit(total & 1), cout: bit(total >> 1) };
    },
  },
  {
    name: 'ripple_adder_2bit',
    kind: 'boolean',
    purpose: 'Two-bit ripple-carry adder: a1a0 + b1b0 = c s1 s0.',
    source: [
      'in a0, a1, b0, b1',
      'let g0 = a0 AND b0',
      's0 = a0 XOR b0',
      'let p1 = a1 XOR b1',
      's1 = p1 XOR g0',
      'c = (a1 AND b1) OR (p1 AND g0)',
    ].join('\n'),
    inputs: ['a0', 'a1', 'b0', 'b1'],
    reference: ([a0, a1, b0, b1]) => {
      const total = (a0! + 2 * a1!) + (b0! + 2 * b1!);
      return { s0: bit(total & 1), s1: bit((total >> 1) & 1), c: bit((total >> 2) & 1) };
    },
  },
  {
    name: 'comparator_2bit',
    kind: 'boolean',
    purpose: 'Two-bit magnitude comparator: greater / equal / less.',
    source: [
      'in a0, a1, b0, b1',
      'let hi_eq = a1 XNOR b1',
      'let lo_eq = a0 XNOR b0',
      'eq = hi_eq AND lo_eq',
      'gt = (a1 AND NOT b1) OR (hi_eq AND (a0 AND NOT b0))',
      'lt = (b1 AND NOT a1) OR (hi_eq AND (b0 AND NOT a0))',
    ].join('\n'),
    inputs: ['a0', 'a1', 'b0', 'b1'],
    reference: ([a0, a1, b0, b1]) => {
      const a = a0! + 2 * a1!;
      const b = b0! + 2 * b1!;
      return { eq: bit(a === b), gt: bit(a > b), lt: bit(a < b) };
    },
  },
  {
    name: 'mux4',
    kind: 'boolean',
    purpose: 'Four-to-one multiplexer selected by two address bits.',
    source: [
      'in s0, s1, d0, d1, d2, d3',
      'let lo = MUX(s0, d1, d0)',
      'let hi = MUX(s0, d3, d2)',
      'out = MUX(s1, hi, lo)',
    ].join('\n'),
    inputs: ['s0', 's1', 'd0', 'd1', 'd2', 'd3'],
    reference: ([s0, s1, d0, d1, d2, d3]) => {
      const data = [d0!, d1!, d2!, d3!];
      return { out: data[s0! + 2 * s1!]! };
    },
  },
  {
    name: 'parity8',
    kind: 'boolean',
    purpose: 'Odd parity over eight bits — the canonical CNOT-only circuit.',
    source: ['in b0, b1, b2, b3, b4, b5, b6, b7', 'parity = b0 XOR b1 XOR b2 XOR b3 XOR b4 XOR b5 XOR b6 XOR b7'].join(
      '\n',
    ),
    inputs: ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'],
    reference: (bits) => ({ parity: bit(bits.reduce<number>((acc, b) => acc ^ b, 0)) }),
  },
  {
    name: 'majority3',
    kind: 'boolean',
    purpose: 'Majority vote of three bits, the carry function of a full adder.',
    source: ['in a, b, c', 'maj = (a AND b) OR (b AND c) OR (a AND c)'].join('\n'),
    inputs: ['a', 'b', 'c'],
    reference: ([a, b, c]) => ({ maj: bit(a! + b! + c! >= 2) }),
  },
  {
    name: 'grover_oracle_3',
    kind: 'boolean',
    purpose: 'Grover oracle marking the single state |101>, with the marking asserted.',
    source: [
      'in x0, x1, x2',
      'mark = x0 AND NOT x1 AND x2',
      'assert only_target: mark XNOR (x0 AND NOT x1 AND x2)',
    ].join('\n'),
    inputs: ['x0', 'x1', 'x2'],
    reference: ([x0, x1, x2]) => ({ mark: bit(x0! === 1 && x1! === 0 && x2! === 1) }),
  },
];

export function entry(name: string): CorpusEntry {
  const found = CORPUS.find((c) => c.name === name);
  if (!found) throw new Error(`no corpus entry named "${name}"`);
  return found;
}
