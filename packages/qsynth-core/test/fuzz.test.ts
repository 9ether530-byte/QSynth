/**
 * Fuzzing the front doors.
 *
 * The contract being tested is Global Constraint #3 — no silent failures — stated as its
 * contrapositive: *whatever* bytes arrive, the compiler either produces a verified result
 * or throws a `QsynthError` carrying a code, a message and a hint. What it must never do
 * is throw a bare `TypeError`, hang, or return something unverified.
 *
 * That matters beyond tidiness: `handler.ts` maps `QsynthError.code` to an HTTP status and
 * puts `hint` in the response body. An error that escapes as a raw `TypeError` becomes a
 * 500 with no guidance, which is exactly the experience US-10 forbids.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compile, parseTruthTable, QsynthError, type SpecKind } from '@qsynth/core';
import { CORPUS } from './corpus.js';

const CODES = new Set([
  'PARSE_ERROR',
  'UNSUPPORTED_CONSTRUCT',
  'INVALID_SPEC',
  'SPEC_TOO_LARGE',
  'BUDGET_EXCEEDED',
  'VERIFICATION_FAILED',
  'INTERNAL',
]);

/**
 * Compile and classify. Anything that is not a `QsynthError` is re-thrown so the property
 * fails loudly with the original stack — an untyped error is the bug we are hunting.
 */
function attempt(kind: SpecKind, source: string): 'compiled' | QsynthError {
  try {
    const result = compile({ kind, source });
    // A result that came back must be internally consistent, even from nonsense input.
    expect(result.report.checks).toHaveLength(6);
    expect(result.qasm.startsWith('OPENQASM 3.0;')).toBe(true);
    return 'compiled';
  } catch (error) {
    if (!(error instanceof QsynthError)) throw error;
    expect(CODES.has(error.code), `unknown error code ${error.code}`).toBe(true);
    expect(error.message.length, 'an error with no message').toBeGreaterThan(0);
    expect(error.hint.length, `no hint on ${error.code}: ${error.message}`).toBeGreaterThan(0);
    // INTERNAL means a compiler invariant broke — a bug, not bad input. Fuzzing must not
    // be able to provoke one.
    expect(error.code, `internal error on input: ${JSON.stringify(source)}`).not.toBe('INTERNAL');
    return error;
  }
}

describe('arbitrary bytes into the Boolean parser', () => {
  it('always yields either a circuit or a typed error', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (source) => {
        attempt('boolean', source);
      }),
      { numRuns: 500 },
    );
  });

  it('survives text built from the language\'s own vocabulary', () => {
    // Pure random strings mostly die in the lexer. Sampling from real tokens gets deeper
    // into the parser, which is where the interesting failures live.
    const token = fc.constantFrom(
      'in',
      'let',
      'assert',
      'out',
      'a',
      'b',
      'MUX',
      'AND',
      'OR',
      'XOR',
      'NAND',
      'NOR',
      'XNOR',
      'NOT',
      '(',
      ')',
      ',',
      '=',
      ':',
      '0',
      '1',
      '\n',
      '&',
      '|',
      '^',
      '!',
      '~',
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 40 }), (tokens) => {
        attempt('boolean', tokens.join(' '));
      }),
      { numRuns: 1000 },
    );
  });

  it('survives corpus specs with one character removed, duplicated or replaced', () => {
    const boolean = CORPUS.filter((c) => c.kind === 'boolean');
    fc.assert(
      fc.property(
        fc.constantFrom(...boolean.map((c) => c.source)),
        fc.nat(),
        fc.constantFrom('delete', 'duplicate', 'replace'),
        fc.constantFrom('(', ')', 'X', ' ', '\n', ',', '='),
        (source, position, kind, replacement) => {
          const at = position % source.length;
          const damaged =
            kind === 'delete'
              ? source.slice(0, at) + source.slice(at + 1)
              : kind === 'duplicate'
                ? source.slice(0, at) + source[at] + source.slice(at)
                : source.slice(0, at) + replacement + source.slice(at + 1);
          attempt('boolean', damaged);
        },
      ),
      { numRuns: 1500 },
    );
  });
});

describe('arbitrary bytes into the truth-table parser', () => {
  it('always yields either a circuit or a typed error', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (source) => {
        attempt('truthtable', source);
      }),
      { numRuns: 500 },
    );
  });

  it('survives table-shaped noise', () => {
    const cell = fc.constantFrom('0', '1', '-', 'x', 'a', 'b', 'out', '|', '->', ' ', ',', '#');
    const line = fc.array(cell, { maxLength: 10 }).map((cells) => cells.join(' '));
    fc.assert(
      fc.property(fc.array(line, { maxLength: 12 }), (lines) => {
        attempt('truthtable', lines.join('\n'));
      }),
      { numRuns: 1000 },
    );
  });

  it('never accepts a table it cannot reproduce', () => {
    // If the parser returns a table, every row it kept must survive the round trip into
    // the circuit. Half-parsed tables that quietly drop rows would show up here.
    const cell = fc.constantFrom('0', '1');
    fc.assert(
      fc.property(fc.array(fc.tuple(cell, cell, cell), { minLength: 1, maxLength: 4 }), (rows) => {
        const seen = new Set<string>();
        const unique = rows.filter((r) => {
          const key = `${r[0]}${r[1]}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const source = ['a b | out', ...unique.map((r) => `${r[0]} ${r[1]} | ${r[2]}`)].join('\n');
        const table = parseTruthTable(source);
        expect(table.rows).toHaveLength(unique.length);
        const result = compile({ kind: 'truthtable', source });
        expect(result.report.passed).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('inputs that are hostile rather than merely malformed', () => {
  const cases: readonly { readonly name: string; readonly kind: SpecKind; readonly source: string }[] = [
    { name: 'an empty spec', kind: 'boolean', source: '' },
    { name: 'only whitespace', kind: 'boolean', source: '   \n\t\n  ' },
    { name: 'only comments', kind: 'boolean', source: '# nothing here\n# nor here' },
    { name: 'a null byte', kind: 'boolean', source: 'out = a\0 AND b' },
    { name: 'a lone surrogate', kind: 'boolean', source: 'out = a AND \ud800' },
    { name: 'right-to-left override', kind: 'boolean', source: 'out = a ‮ AND b' },
    { name: 'combining marks in an identifier', kind: 'boolean', source: 'oút = a AND b' },
    { name: 'CRLF line endings', kind: 'boolean', source: 'in a, b\r\nout = a AND b\r\n' },
    { name: 'a very long identifier', kind: 'boolean', source: `out = ${'z'.repeat(5000)}` },
    { name: 'deeply nested brackets', kind: 'boolean', source: `out = ${'('.repeat(500)}a${')'.repeat(500)}` },
    { name: 'unbalanced brackets', kind: 'boolean', source: `out = ${'('.repeat(500)}a` },
    { name: 'a self-referential definition', kind: 'boolean', source: 'out = out AND a' },
    { name: 'an output that is never assigned', kind: 'boolean', source: 'in a, b\nlet t = a AND b' },
    { name: 'a table with no header', kind: 'truthtable', source: '0 0 | 0\n1 1 | 1' },
    { name: 'a table of separators', kind: 'truthtable', source: '| | |\n| | |' },
    { name: 'a table row longer than its header', kind: 'truthtable', source: 'a | out\n0 0 0 | 1' },
  ];

  it.each(cases)('handles $name without an untyped error', ({ kind, source }) => {
    attempt(kind, source);
  });

  it('refuses a source larger than the byte limit rather than trying', () => {
    const huge = `in a\nout = ${Array.from({ length: 40_000 }, () => 'a').join(' XOR ')}`;
    const error = attempt('boolean', huge);
    expect(error).toBeInstanceOf(QsynthError);
    expect((error as QsynthError).code).toBe('SPEC_TOO_LARGE');
  });

  it('finishes quickly even on the pathological cases', () => {
    const started = performance.now();
    for (const { kind, source } of cases) attempt(kind, source);
    // Generous, but it would catch catastrophic backtracking or an accidental O(2^n).
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
