import { describe, expect, it } from 'vitest';
import {
  assignmentToBits,
  compile,
  evaluate,
  lowerTruthTable,
  parseTruthTable,
  QsynthError,
  TraceRecorder,
} from '@qsynth/core';

const FULL_ADDER = `
# a b cin | sum cout
a b cin | sum cout
0 0 0 | 0 0
0 0 1 | 1 0
0 1 0 | 1 0
0 1 1 | 0 1
1 0 0 | 1 0
1 0 1 | 0 1
1 1 0 | 0 1
1 1 1 | 1 1
`;

describe('parsing', () => {
  it('reads the header and every row', () => {
    const table = parseTruthTable(FULL_ADDER);
    expect(table.inputs).toEqual(['a', 'b', 'cin']);
    expect(table.outputs).toEqual(['sum', 'cout']);
    expect(table.rows).toHaveLength(8);
    expect(table.dontCare).toEqual([]);
  });

  it('accepts "->" as well as "|", and cells run together or separated', () => {
    const compact = parseTruthTable('a b -> out\n00 -> 0\n01->1\n1 0 -> 1\n11 -> 0\n');
    expect(compact.rows.map((r) => r.outputs[0])).toEqual([0, 1, 1, 0]);
  });

  it('indexes rows with input 0 as the least significant bit', () => {
    const table = parseTruthTable('a b | out\n0 1 | 1\n');
    // a=0, b=1 → assignment 2
    expect(table.rows[0]!.assignment).toBe(2);
  });

  it('records omitted rows as don\'t-care', () => {
    const table = parseTruthTable('a b | out\n0 0 | 0\n1 1 | 1\n');
    expect(table.dontCare).toEqual([1, 2]);
  });

  it('records a "-" output cell as don\'t-care for that whole assignment', () => {
    const table = parseTruthTable('a b | x y\n0 0 | 0 0\n0 1 | 1 -\n1 0 | 0 1\n1 1 | 1 1\n');
    expect(table.dontCare).toEqual([2]);
  });

  it('refuses a duplicated input combination, pointing at the first occurrence', () => {
    const error = grab(() => parseTruthTable('a | out\n0 | 0\n1 | 1\n0 | 1\n'));
    expect(error.message).toContain('appears twice');
    expect(error.message).toContain('line 2');
  });

  it('refuses a "-" in an input column', () => {
    expect(grab(() => parseTruthTable('a b | out\n- 1 | 1\n')).hint).toContain('outputs only');
  });

  it('refuses a row with the wrong number of cells', () => {
    expect(grab(() => parseTruthTable('a b | out\n0 | 1\n')).message).toContain('1 input cell(s)');
  });

  it('refuses a line with no separator', () => {
    expect(grab(() => parseTruthTable('a b out\n0 0 0\n')).message).toContain('no separator');
  });

  it('refuses more inputs than can be enumerated', () => {
    const names = Array.from({ length: 13 }, (_, i) => `a${i}`).join(' ');
    const error = grab(() => parseTruthTable(`${names} | out\n${'0 '.repeat(13)}| 0\n`));
    expect(error.code).toBe('INVALID_SPEC');
    expect(error.hint).toContain('Boolean expression instead');
  });

  it('refuses a header with no rows', () => {
    expect(grab(() => parseTruthTable('a b | out\n')).message).toContain('no rows');
  });
});

describe('synthesis', () => {
  it('produces a module that reproduces every specified row', () => {
    const table = parseTruthTable(FULL_ADDER);
    const module = lowerTruthTable(FULL_ADDER);
    for (const row of table.rows) {
      const values = evaluate(module, row.inputBits);
      expect(values.outputs.sum, `sum at ${row.inputBits.join('')}`).toBe(row.outputs[0]);
      expect(values.outputs.cout, `cout at ${row.inputBits.join('')}`).toBe(row.outputs[1]);
    }
  });

  it('shares subfunctions instead of emitting one term per row', () => {
    const trace = new TraceRecorder();
    const module = lowerTruthTable(FULL_ADDER, { trace });
    // Sum-of-products would need ~4 four-literal terms per output. Shannon with sharing
    // stays in single digits of MUX nodes, which is what keeps verification affordable.
    const muxes = module.nodes.filter((n) => n.op === 'mux');
    expect(muxes.length).toBeLessThanOrEqual(8);

    const synthesis = trace.toArray().find((e) => e.kind === 'table.synthesis')!;
    expect((synthesis.detail as { memoHits: number }).memoHits).toBeGreaterThan(0);
  });

  it('drops variables an output does not depend on', () => {
    // out = a, regardless of b: no MUX on b should survive.
    const module = lowerTruthTable('a b | out\n0 0 | 0\n0 1 | 0\n1 0 | 1\n1 1 | 1\n');
    expect(module.nodes.filter((n) => n.op === 'mux')).toHaveLength(1);
  });

  it('carries the don\'t-care set into the module, and explains it in the trace', () => {
    const trace = new TraceRecorder();
    const module = lowerTruthTable('a b | out\n0 0 | 0\n1 1 | 1\n', { trace });
    expect(module.dontCare).toEqual([1, 2]);
    const entry = trace.toArray().find((e) => e.kind === 'table.dontcare')!;
    expect(entry.message).toContain('unconstrained');
  });
});

describe('end to end', () => {
  it('compiles the full adder to a verified circuit', () => {
    const result = compile({ kind: 'truthtable', source: FULL_ADDER, name: 'full_adder' });
    expect(result.report.passed).toBe(true);
    expect(result.report.checks.find((c) => c.id === 'simulation_equivalence')!.coverage).toMatchObject({
      mode: 'exhaustive',
      checked: 8,
      space: 8,
    });
  });

  it('agrees with the arithmetic it claims to implement', () => {
    const result = compile({ kind: 'truthtable', source: FULL_ADDER });
    for (let a = 0; a < 8; a++) {
      const bits = assignmentToBits(a, 3);
      const total = bits[0]! + bits[1]! + bits[2]!;
      const outputs = evaluate(result.module, bits).outputs;
      expect(outputs.sum).toBe(total & 1);
      expect(outputs.cout).toBe(total >> 1);
    }
  });

  it('does not hold the circuit to unspecified rows', () => {
    const result = compile({ kind: 'truthtable', source: 'a b | out\n0 0 | 1\n1 1 | 0\n' });
    expect(result.report.passed).toBe(true);
    expect(result.report.checks.find((c) => c.id === 'simulation_equivalence')!.coverage!.dontCare).toBe(2);
  });
});

function grab(fn: () => unknown): QsynthError {
  try {
    fn();
  } catch (error) {
    if (error instanceof QsynthError) return error;
    throw error;
  }
  throw new Error('expected a QsynthError, but nothing was thrown');
}
