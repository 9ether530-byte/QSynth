import { describe, expect, it } from 'vitest';
import { assignmentToBits, evaluate, lowerBoolean, parseBoolean, QsynthError, tokenize, TraceRecorder, type Bit } from '@qsynth/core';

/** Every output, for every input assignment — the only honest way to test a parser that feeds a compiler. */
function table(source: string): Record<string, Bit>[] {
  const module = lowerBoolean(source);
  const rows: Record<string, Bit>[] = [];
  for (let a = 0; a < 2 ** module.inputs.length; a++) {
    rows.push(evaluate(module, assignmentToBits(a, module.inputs.length)).outputs);
  }
  return rows;
}

function outputs(source: string, name = 'out'): Bit[] {
  return table(source).map((row) => row[name]!);
}

describe('lexer', () => {
  it('drops comments and keeps line numbers accurate', () => {
    const tokens = tokenize('# a comment\nout = a\n');
    expect(tokens.filter((t) => t.kind === 'ident').map((t) => t.value)).toEqual(['out', 'a']);
    expect(tokens.find((t) => t.value === 'out')!.span.line).toBe(2);
  });

  it('accepts symbol and word forms of the same operator', () => {
    expect(outputs('out = a & b')).toEqual(outputs('out = a AND b'));
    expect(outputs('out = a | b')).toEqual(outputs('out = a OR b'));
    expect(outputs('out = a ^ b')).toEqual(outputs('out = a XOR b'));
    expect(outputs('out = !a')).toEqual(outputs('out = NOT a'));
  });

  it('rejects multi-digit numbers with a span', () => {
    const error = grab(() => tokenize('out = 10'));
    expect(error.code).toBe('PARSE_ERROR');
    expect(error.message).toContain('not a bit literal');
    expect(error.span?.line).toBe(1);
  });

  it('names the offending character', () => {
    expect(grab(() => tokenize('out = a $ b')).message).toContain('"$"');
  });
});

describe('precedence', () => {
  it('binds AND tighter than OR', () => {
    // a OR (b AND c): true unless a is 0 and b·c is 0.
    expect(outputs('out = a OR b AND c')).toEqual([0, 1, 0, 1, 0, 1, 1, 1]);
  });

  it('binds XOR looser than AND and tighter than OR', () => {
    expect(outputs('out = a XOR b AND c')).toEqual(outputs('out = a XOR (b AND c)'));
    expect(outputs('out = a OR b XOR c')).toEqual(outputs('out = a OR (b XOR c)'));
  });

  it('binds NOT tightest', () => {
    expect(outputs('out = NOT a AND b')).toEqual(outputs('out = (NOT a) AND b'));
  });

  it('is left-associative', () => {
    expect(outputs('out = a NAND b NAND c')).toEqual(outputs('out = (a NAND b) NAND c'));
    // Stated because NAND is not associative — the grouping is a real decision, not a formality.
    expect(outputs('out = a NAND b NAND c')).not.toEqual(outputs('out = a NAND (b NAND c)'));
  });
});

describe('operators', () => {
  const cases: [string, Bit[]][] = [
    ['out = a AND b', [0, 0, 0, 1]],
    ['out = a OR b', [0, 1, 1, 1]],
    ['out = a XOR b', [0, 1, 1, 0]],
    ['out = a NAND b', [1, 1, 1, 0]],
    ['out = a NOR b', [1, 0, 0, 0]],
    ['out = a XNOR b', [1, 0, 0, 1]],
  ];
  it.each(cases)('%s', (source, expected) => {
    expect(outputs(source)).toEqual(expected);
  });

  it('MUX selects the second operand when the selector is 1', () => {
    // inputs in first-use order: s, x, y → assignment bit 0 = s.
    const rows = outputs('out = MUX(s, x, y)');
    for (let a = 0; a < 8; a++) {
      const [s, x, y] = [a & 1, (a >> 1) & 1, (a >> 2) & 1];
      expect(rows[a]).toBe(s === 1 ? x : y);
    }
  });

  it('supports literal constants', () => {
    expect(outputs('out = a AND 1')).toEqual([0, 1]);
    expect(outputs('out = a AND 0')).toEqual([0, 0]);
  });
});

describe('statements', () => {
  it('treats unassigned names as inputs in first-use order', () => {
    const module = lowerBoolean('out = b AND a');
    expect(module.inputs.map((i) => i.name)).toEqual(['b', 'a']);
  });

  it('honours an explicit input order', () => {
    const module = lowerBoolean('in a, b\nout = b AND a');
    expect(module.inputs.map((i) => i.name)).toEqual(['a', 'b']);
  });

  it('refuses unknown names once inputs are declared explicitly, and suggests the near miss', () => {
    const error = grab(() => lowerBoolean('in alpha, beta\nout = alhpa AND beta'));
    expect(error.code).toBe('PARSE_ERROR');
    expect(error.hint).toContain('alpha');
    expect(error.span?.line).toBe(2);
  });

  it('keeps let bindings out of the output list', () => {
    const module = lowerBoolean('let t = a AND b\nout = t XOR c');
    expect(module.outputs.map((o) => o.name)).toEqual(['out']);
    expect(outputs('let t = a AND b\nout = t XOR c')).toEqual(outputs('out = (a AND b) XOR c'));
  });

  it('supports several outputs', () => {
    const rows = table('in a, b\nsum = a XOR b\ncarry = a AND b');
    expect(rows.map((r) => r.sum)).toEqual([0, 1, 1, 0]);
    expect(rows.map((r) => r.carry)).toEqual([0, 0, 0, 1]);
  });

  it('names assertions, positionally when the user does not', () => {
    const named = lowerBoolean('in a\nout = a\nassert nonzero: a OR NOT a');
    expect(named.assertions.map((x) => x.name)).toEqual(['nonzero']);
    const anonymous = lowerBoolean('in a\nout = a\nassert a OR NOT a');
    expect(anonymous.assertions.map((x) => x.name)).toEqual(['assertion_1']);
  });

  it('refuses a redefined name', () => {
    expect(grab(() => lowerBoolean('in a\nout = a\nout = NOT a')).message).toContain('already defined');
    expect(grab(() => lowerBoolean('in a\nlet a = 1\nout = a')).hint).toContain('cannot be reassigned');
  });

  it('refuses a specification with no outputs', () => {
    expect(grab(() => lowerBoolean('in a, b')).code).toBe('INVALID_SPEC');
  });

  it('refuses two statements on one line', () => {
    expect(grab(() => lowerBoolean('out = a in b')).message).toContain('end of the line');
  });

  it('reports an unclosed parenthesis where it ran out, not at the end of the file', () => {
    const error = grab(() => lowerBoolean('out = (a AND b\nother = c\n'));
    expect(error.code).toBe('PARSE_ERROR');
    expect(error.span?.line).toBe(1);
  });
});

describe('trace', () => {
  it('records why a name became an input', () => {
    const trace = new TraceRecorder();
    lowerBoolean('out = a AND b', { trace });
    const entries = trace.toArray().filter((e) => e.kind === 'input.implicit');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.message).toContain('never assigned');
    expect(entries[0]!.span).toBeDefined();
  });
});

describe('parseBoolean', () => {
  it('produces spans that cover the whole expression', () => {
    const program = parseBoolean('out = a AND b');
    const statement = program.statements[0]!;
    expect(statement.kind).toBe('output');
    expect(statement.span.start).toBe(0);
    expect(statement.span.end).toBe('out = a AND b'.length);
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
