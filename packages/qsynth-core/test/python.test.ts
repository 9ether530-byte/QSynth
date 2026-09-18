/**
 * The Python subset, tested the way the subset is defined: exhaustively where it claims
 * to compute something, and by name where it claims to refuse something.
 *
 * `evaluatesAs` is the workhorse. It compiles a function, runs it over its *entire* input
 * space, and compares against a reference written in plain TypeScript from the arithmetic
 * rather than from the lowering. For the widths used here that is at most a few thousand
 * assignments, so there is no reason to sample — and an adder that is right on 4095 of
 * 4096 inputs is an adder that is wrong.
 *
 * The refusals get the same weight as the results. A subset whose boundary is untested is
 * a subset that grows by accident, so every `UNSUPPORTED_CONSTRUCT` and every width error
 * is asserted with its code *and* the line it points at — an error with no span is an
 * error the editor cannot put a marker on.
 */
import { describe, expect, it } from 'vitest';
import {
  assignmentToBits,
  compile,
  evaluate,
  evaluateOutputVector,
  lowerPython,
  parsePython,
  QsynthError,
  tokenizePython,
  TraceRecorder,
  MAX_UNROLL,
  type Bit,
  type ClassicalModule,
} from '@qsynth/core';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Parameter and output names grouped back into the widths the source declared. */
function fields(names: readonly string[]): { name: string; width: number }[] {
  const grouped: { name: string; width: number }[] = [];
  for (const full of names) {
    const base = /^(.*)\[\d+\]$/.exec(full)?.[1] ?? full;
    const last = grouped[grouped.length - 1];
    if (last && last.name === base) last.width++;
    else grouped.push({ name: base, width: 1 });
  }
  return grouped;
}

/** Split a bit vector into the integers its fields represent, least significant bit first. */
function unpack(bits: readonly Bit[], widths: readonly number[]): number[] {
  const values: number[] = [];
  let index = 0;
  for (const width of widths) {
    let value = 0;
    for (let i = 0; i < width; i++) value |= bits[index++]! << i;
    values.push(value);
  }
  return values;
}

/** Every (inputs → outputs) pair the compiled function produces, as integers. */
function table(module: ClassicalModule): { inputs: number[]; outputs: number[] }[] {
  const inputWidths = fields(module.inputs.map((i) => i.name)).map((f) => f.width);
  const outputWidths = fields(module.outputs.map((o) => o.name)).map((f) => f.width);
  const rows: { inputs: number[]; outputs: number[] }[] = [];
  for (let a = 0; a < 2 ** module.inputs.length; a++) {
    const bits = assignmentToBits(a, module.inputs.length);
    rows.push({
      inputs: unpack(bits, inputWidths),
      outputs: unpack(evaluateOutputVector(module, bits), outputWidths),
    });
  }
  return rows;
}

/**
 * Compile `source` and assert it agrees with `reference` on every input assignment.
 * Returns the module so a caller can also assert something about its shape.
 */
function evaluatesAs(source: string, reference: (...args: number[]) => number | number[]): ClassicalModule {
  const module = lowerPython(source);
  for (const row of table(module)) {
    const expected = reference(...row.inputs);
    expect(row.outputs, `inputs ${JSON.stringify(row.inputs)}`).toEqual(
      Array.isArray(expected) ? expected : [expected],
    );
  }
  return module;
}

/** The typed error a source raises, or a failure if it compiled. */
function refusal(source: string): QsynthError {
  try {
    lowerPython(source);
  } catch (error) {
    if (error instanceof QsynthError) return error;
    throw error;
  }
  throw new Error('expected the specification to be refused, but it compiled');
}

const lines = (...text: string[]) => text.join('\n') + '\n';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

describe('lexer', () => {
  it('turns indentation into block structure', () => {
    const kinds = tokenizePython(lines('def f(a: bit) -> bit:', '    if a:', '        b = a', '    return a'))
      .filter((t) => t.kind === 'indent' || t.kind === 'dedent')
      .map((t) => t.kind);
    expect(kinds).toEqual(['indent', 'indent', 'dedent', 'dedent']);
  });

  it('ignores the indentation of blank and comment-only lines', () => {
    // A stray comment at column 1 inside a suite must not close the suite — this is the
    // difference between a file that compiles and one that reports a phantom dedent.
    const module = lowerPython(lines('def f(a: bit) -> bit:', '    b = a', '', '# note', '    return b'));
    expect(module.outputs.map((o) => o.name)).toEqual(['b']);
  });

  it('refuses tabs in indentation, naming the line', () => {
    const error = refusal('def f(a: bit) -> bit:\n\treturn a\n');
    expect(error.code).toBe('PARSE_ERROR');
    expect(error.message).toContain('tab');
    expect(error.span?.line).toBe(2);
  });

  it('refuses a dedent that lands between two open blocks, and says where they are', () => {
    const error = refusal(lines('def f(a: bit) -> bit:', '    if a:', '        b = a', '      c = a', '    return a'));
    expect(error.code).toBe('PARSE_ERROR');
    expect(error.span?.line).toBe(4);
    // The user cannot fix "unexpected indent" without being told what to line up with.
    expect(error.hint).toContain('column');
  });

  it('treats newlines inside brackets as whitespace', () => {
    const module = lowerPython('def f(\n  a: bit,\n  b: bit,\n) -> bit:\n    return a & b\n');
    expect(module.inputs.map((i) => i.name)).toEqual(['a', 'b']);
  });

  it('accepts binary and hex literals, which is how bit patterns get written', () => {
    evaluatesAs(lines('def f(x: uint4) -> uint4:', '    return x & 0b1010'), (x) => x & 0b1010);
    evaluatesAs(lines('def f(x: uint4) -> uint4:', '    return x ^ 0xF'), (x) => x ^ 0xf);
  });

  it.each([
    ['a float', 'def f(a: bit) -> bit:\n    x = 1.5\n    return a\n', 'Floating-point'],
    ['a string', "def f(a: bit) -> bit:\n    x = 'hi'\n    return a\n", 'String literals'],
  ])('refuses %s with a reason rather than a stray character', (_what, source, expected) => {
    const error = refusal(source);
    expect(error.code).toBe('PARSE_ERROR');
    expect(error.message).toContain(expected);
    expect(error.span?.line).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Parser: precedence and shape
// ---------------------------------------------------------------------------

describe('parser', () => {
  it('binds & ^ | tighter than the comparisons, exactly as Python does', () => {
    // The one precedence everybody gets wrong: `a & b == c` is `(a & b) == c`. Getting
    // this backwards would compile, run, and quietly mean something else.
    evaluatesAs(lines('def f(a: uint2, b: uint2, c: uint2) -> bit:', '    return a & b == c'), (a, b, c) =>
      (a & b) === c ? 1 : 0,
    );
    evaluatesAs(lines('def f(a: uint2, b: uint2, c: uint2) -> bit:', '    return a | b != c'), (a, b, c) =>
      (a | b) !== c ? 1 : 0,
    );
  });

  it('binds shifts tighter than | and looser than nothing in between', () => {
    evaluatesAs(lines('def f(x: uint2) -> uint4:', '    return x << 1 | 1'), (x) => ((x << 1) | 1) & 0b1111);
  });

  it('desugars a chained comparison to the conjunction Python means', () => {
    evaluatesAs(lines('def f(x: uint2, y: uint2, z: uint2) -> bit:', '    return x < y < z'), (x, y, z) =>
      x < y && y < z ? 1 : 0,
    );
  });

  it('desugars elif into a nested if', () => {
    const fn = parsePython(lines(
      'def f(x: uint2) -> uint2:',
      '    if x == 0:',
      '        r: uint2 = 3',
      '    elif x == 1:',
      '        r: uint2 = 2',
      '    else:',
      '        r: uint2 = 0',
      '    return r',
    ));
    const first = fn.body[0]!;
    expect(first.kind).toBe('if');
    // One branch construct in the AST, not two spellings of it.
    expect(first.kind === 'if' && first.orelse.length === 1 && first.orelse[0]!.kind === 'if').toBe(true);
  });

  it('reads both tuple spellings of a multi-output return type', () => {
    for (const annotation of ['(bit, bit)', 'tuple[bit, bit]']) {
      const fn = parsePython(lines(`def f(a: bit, b: bit) -> ${annotation}:`, '    return a ^ b, a & b'));
      expect(fn.returns.map((t) => t.kind)).toEqual(['bit', 'bit']);
      expect(fn.returnsTuple).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Refusals — the boundary of the subset
// ---------------------------------------------------------------------------

describe('refusals', () => {
  const unsupportedCases: readonly [string, string, string][] = [
    ['multiplication', 'def f(a: uint2, b: uint2) -> uint4:\n    return a * b\n', 'Multiplication'],
    ['division', 'def f(a: uint2) -> uint2:\n    return a / 2\n', 'Division'],
    ['floor division', 'def f(a: uint2) -> uint2:\n    return a // 2\n', 'Floor division'],
    ['modulo', 'def f(a: uint2) -> uint2:\n    return a % 2\n', 'modulo'],
    ['exponentiation', 'def f(a: uint2) -> uint2:\n    return a ** 2\n', 'Exponentiation'],
    ['a while loop', 'def f(a: bit) -> bit:\n    while a:\n        pass\n    return a\n', 'while loop'],
    ['a call', 'def f(a: bit) -> bit:\n    return g(a)\n', 'Calling a function'],
    ['attribute access', 'def f(a: bit) -> bit:\n    return a.x\n', 'Attribute access'],
    ['a nested def', 'def f(a: bit) -> bit:\n    def g():\n        pass\n    return a\n', 'nested function'],
    ['a list literal', 'def f(a: bit) -> bit:\n    x = [a]\n    return a\n', 'list literal'],
    ['unary minus', 'def f(x: uint2) -> uint2:\n    return -x\n', 'Unary minus'],
    ['indexed assignment', 'def f(x: uint2) -> uint2:\n    x[0] = 1\n    return x\n', 'Assigning to an index'],
    ['a semicolon', 'def f(a: bit) -> bit:\n    b = a; c = a\n    return b\n', 'semicolon'],
    ['iterating a name', 'def f(a: bit) -> bit:\n    for i in a:\n        pass\n    return a\n', 'Iterating over'],
    ['a return inside a branch', 'def f(a: bit) -> bit:\n    if a:\n        return a\n    return a\n', 'last line'],
  ];

  it.each(unsupportedCases)('refuses %s by name, with a span', (_what, source, expected) => {
    const error = refusal(source);
    expect(error.code).toBe('UNSUPPORTED_CONSTRUCT');
    expect(error.message).toContain(expected);
    expect(error.span, 'every refusal needs a span or the editor cannot mark it').toBeDefined();
    expect(error.span!.line).toBeGreaterThanOrEqual(2);
    // The refusal has to say what the subset *does* accept, or the user is stuck.
    expect(error.hint.length).toBeGreaterThan(20);
  });

  it('names the construct rather than the token for every reserved word', () => {
    // A blacklist that reported "unexpected identifier" for `import` would leave the user
    // guessing whether it was a typo.
    for (const [word, expected] of [
      ['import os\ndef f(a: bit) -> bit:\n    return a\n', 'import'],
      ['def f(a: bit) -> bit:\n    x = lambda: 1\n    return a\n', 'lambda'],
      ['def f(a: bit) -> bit:\n    del a\n    return a\n', 'del'],
      ['def f(a: bit) -> bit:\n    if a is None:\n        pass\n    return a\n', '"is" operator'],
    ] as const) {
      const error = refusal(word);
      expect(error.message.toLowerCase()).toContain(expected.toLowerCase());
    }
  });

  it.each([
    ['an untyped parameter', 'def f(a) -> bit:\n    return a\n', 'type annotation'],
    ['a missing return type', 'def f(a: bit):\n    return a\n', 'return type annotation'],
    ['an unknown type', 'def f(a: int) -> bit:\n    return a\n', 'not a type in the subset'],
    ['an oversized width', 'def f(a: uint99) -> bit:\n    return a[0]\n', 'out of range'],
    ['no return at all', 'def f(a: bit) -> bit:\n    b = a\n', 'does not end with a return'],
    ['a second function', 'def f(a: bit) -> bit:\n    return a\ndef g(a: bit) -> bit:\n    return a\n', 'exactly one function'],
    ['a one-line suite', 'def f(a: bit) -> bit:\n    if a: b = a\n    return a\n', 'own indented line'],
    ['a mismatched return count', 'def f(a: bit) -> (bit, bit):\n    return a\n', 'declares 2 return value'],
    ['an undefined name', 'def f(alpha: bit) -> bit:\n    return beta\n', 'not defined'],
    ['an update before assignment', 'def f(a: bit) -> bit:\n    b ^= a\n    return a\n', 'no value yet'],
  ])('refuses %s', (_what, source, expected) => {
    const error = refusal(source);
    expect(error.code).toBe('PARSE_ERROR');
    expect(error.message).toContain(expected);
    expect(error.span).toBeDefined();
  });

  it('suggests the name the user probably meant', () => {
    expect(refusal('def f(alpha: bit) -> bit:\n    return alhpa\n').hint).toContain('alpha');
  });

  it.each([
    ['a runtime index', 'def f(x: uint4, i: uint2) -> bit:\n    return x[i]\n', 'known when the circuit is built'],
    ['an out-of-range index', 'def f(x: uint2) -> bit:\n    return x[5]\n', 'does not exist'],
    ['an empty slice', 'def f(x: uint4) -> uint2:\n    return x[3:1]\n', 'does not select any bits'],
    ['narrowing to a bit', 'def f(x: uint4) -> bit:\n    r: bit = x\n    return r\n', 'declared as a bit'],
    ['inverting a literal', 'def f(a: bit) -> bit:\n    x = ~1\n    return a\n', 'no width to invert'],
    ['a zero step', 'def f(a: bit) -> bit:\n    for i in range(0, 4, 0):\n        a = a\n    return a\n', 'step of at least 1'],
    ['a name assigned in one branch only', 'def f(a: bit, b: bit) -> bit:\n    if a:\n        r = b\n    return r\n', 'only one branch'],
    ['an assertion that is already false', 'def f(a: bit) -> bit:\n    assert 1 == 2\n    return a\n', 'no circuit can satisfy'],
  ])('refuses %s with a span the editor can mark', (_what, source, expected) => {
    const error = refusal(source);
    expect(error.code).toBe('INVALID_SPEC');
    expect(error.message).toContain(expected);
    expect(error.span?.line).toBe(2);
  });

  it('refuses a loop past the unroll limit, explaining why loops are unrolled', () => {
    const error = refusal(`def f(a: bit) -> bit:\n    for i in range(${MAX_UNROLL + 1}):\n        a = a\n    return a\n`);
    expect(error.code).toBe('INVALID_SPEC');
    expect(error.message).toContain(String(MAX_UNROLL));
    expect(error.hint).toContain('unrolled');
  });
});

// ---------------------------------------------------------------------------
// Arithmetic — exhaustive against an independent reference
// ---------------------------------------------------------------------------

describe('arithmetic', () => {
  it('adds, keeping the carry out in the extra bit', () => {
    evaluatesAs(lines('def f(x: uint3, y: uint3) -> uint4:', '    return x + y'), (x, y) => x + y);
  });

  it('adds three operands, which is where the carry chain composes or does not', () => {
    evaluatesAs(lines('def f(x: uint2, y: uint2, z: uint2) -> uint4:', '    return x + y + z'), (x, y, z) => x + y + z);
  });

  it('wraps a sum at a declared width, which is what declaring one is for', () => {
    evaluatesAs(lines('def f(x: uint3, y: uint3) -> uint3:', '    s: uint3 = x + y', '    return s'), (x, y) => (x + y) & 0b111);
  });

  it('subtracts, wrapping rather than going negative', () => {
    evaluatesAs(lines('def f(x: uint3, y: uint3) -> uint3:', '    return x - y'), (x, y) => (x - y) & 0b111);
  });

  it.each([
    ['<', (x: number, y: number) => (x < y ? 1 : 0)],
    ['<=', (x: number, y: number) => (x <= y ? 1 : 0)],
    ['>', (x: number, y: number) => (x > y ? 1 : 0)],
    ['>=', (x: number, y: number) => (x >= y ? 1 : 0)],
    ['==', (x: number, y: number) => (x === y ? 1 : 0)],
    ['!=', (x: number, y: number) => (x !== y ? 1 : 0)],
  ])('compares with %s over the whole input space', (op, reference) => {
    evaluatesAs(lines('def f(x: uint3, y: uint3) -> bit:', `    return x ${op} y`), reference);
  });

  it('compares operands of different widths by zero-extending the narrower one', () => {
    evaluatesAs(lines('def f(x: uint4, y: uint2) -> bit:', '    return x < y'), (x, y) => (x < y ? 1 : 0));
  });

  it.each([
    ['&', (x: number, y: number) => x & y],
    ['|', (x: number, y: number) => x | y],
    ['^', (x: number, y: number) => x ^ y],
  ])('applies %s bitwise', (op, reference) => {
    evaluatesAs(lines('def f(x: uint3, y: uint3) -> uint3:', `    return x ${op} y`), reference);
  });

  it('inverts within the declared width', () => {
    evaluatesAs(lines('def f(x: uint3) -> uint3:', '    return ~x'), (x) => ~x & 0b111);
  });

  it('shifts and slices without emitting a single gate, because both are rewiring', () => {
    const shifted = evaluatesAs(lines('def f(x: uint3) -> uint5:', '    return x << 2'), (x) => x << 2);
    const sliced = evaluatesAs(lines('def f(x: uint4) -> uint2:', '    return x[1:3]'), (x) => (x >> 1) & 0b11);
    // Only the input nodes and the constant zeros the shift introduced: no operations.
    for (const module of [shifted, sliced]) {
      expect(module.nodes.filter((n) => n.op !== 'input' && n.op !== 'const')).toEqual([]);
    }
  });

  it('shifts right by dropping bits, and past the width leaves zero', () => {
    evaluatesAs(lines('def f(x: uint3) -> uint2:', '    return x >> 1'), (x) => x >> 1);
    evaluatesAs(lines('def f(x: uint3) -> bit:', '    return x >> 9'), () => 0);
  });

  it('indexes a bit', () => {
    evaluatesAs(lines('def f(x: uint4) -> bit:', '    return x[2]'), (x) => (x >> 2) & 1);
  });
});

// ---------------------------------------------------------------------------
// Compile-time values
// ---------------------------------------------------------------------------

describe('compile-time integers', () => {
  it('folds integer arithmetic that never touches an input, at no gate cost', () => {
    const module = evaluatesAs(lines('def f(x: uint4) -> bit:', '    n = 3', '    return x[n - 1]'), (x) => (x >> 2) & 1);
    expect(module.nodes.filter((n) => n.op !== 'input')).toEqual([]);
  });

  it('refuses a compile-time subtraction that goes negative, rather than wrapping it', () => {
    // Both sides are known here, so this is a counting mistake, not a fixed-width wrap —
    // and reporting it as 2^w - 1 would hide the mistake behind a plausible number.
    const error = refusal(lines('def f(x: uint4) -> bit:', '    return x[1 - 3]'));
    expect(error.code).toBe('INVALID_SPEC');
    expect(error.message).toContain('negative');
  });

  it('takes only the reachable side of an if whose condition is known', () => {
    const trace = new TraceRecorder();
    const module = lowerPython(
      lines('def f(a: bit) -> bit:', '    n = 1', '    if n == 1:', '        r = a', '    else:', '        r = not a', '    return r'),
      { trace },
    );
    // The untaken side is not built at all: no `not`, and no mux to select between them.
    expect(module.nodes.some((n) => n.op === 'not' || n.op === 'mux')).toBe(false);
    expect(trace.toArray().some((e) => e.kind === 'branch.constant')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

describe('branches', () => {
  it('selects between the branches with a multiplexer', () => {
    evaluatesAs(
      lines('def f(s: bit, a: uint2, b: uint2) -> uint2:', '    if s:', '        r = a', '    else:', '        r = b', '    return r'),
      (s, a, b) => (s ? a : b),
    );
  });

  it('keeps the value from before the if when only one branch assigns', () => {
    evaluatesAs(
      lines('def f(s: bit, a: uint3) -> uint3:', '    r: uint3 = a', '    if s:', '        r = r + 1', '    return r'),
      (s, a) => (s ? (a + 1) & 0b111 : a),
    );
  });

  it('chains elif into nested selections', () => {
    evaluatesAs(
      lines(
        'def f(x: uint2) -> uint2:',
        '    if x == 0:',
        '        r: uint2 = 3',
        '    elif x == 1:',
        '        r: uint2 = 2',
        '    else:',
        '        r: uint2 = 0',
        '    return r',
      ),
      (x) => (x === 0 ? 3 : x === 1 ? 2 : 0),
    );
  });

  it('nests branches, including one inside the else', () => {
    evaluatesAs(
      lines(
        'def f(a: bit, b: bit, c: uint2) -> uint2:',
        '    r: uint2 = c',
        '    if a:',
        '        if b:',
        '            r: uint2 = 1',
        '    else:',
        '        r: uint2 = 2',
        '    return r',
      ),
      (a, b, c) => (a ? (b ? 1 : c) : 2),
    );
  });

  it('emits no selection gates when the branches change nothing', () => {
    const trace = new TraceRecorder();
    lowerPython(lines('def f(a: bit) -> bit:', '    if a:', '        pass', '    else:', '        pass', '    return a'), { trace });
    expect(trace.toArray().find((e) => e.kind === 'branch.merge')?.detail).toMatchObject({ muxed: 0 });
  });

  it('tests a multi-bit condition for being non-zero, as Python does', () => {
    evaluatesAs(
      lines('def f(x: uint3) -> bit:', '    if x:', '        r = True', '    else:', '        r = False', '    return r'),
      (x) => (x !== 0 ? 1 : 0),
    );
  });

  it('selects with a conditional expression', () => {
    evaluatesAs(lines('def f(s: bit, a: uint2, b: uint2) -> uint2:', '    return a if s else b'), (s, a, b) => (s ? a : b));
  });

  it('refuses a conditional expression with no else, because a circuit produces a bit either way', () => {
    const error = refusal(lines('def f(s: bit, a: bit) -> bit:', '    return a if s'));
    expect(error.code).toBe('PARSE_ERROR');
    expect(error.message).toContain('else');
  });
});

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

describe('loops', () => {
  it('unrolls a loop over range()', () => {
    const trace = new TraceRecorder();
    const module = lowerPython(lines('def f(x: uint4) -> bit:', '    p = x[0]', '    for i in range(1, 4):', '        p = p ^ x[i]', '    return p'), { trace });
    // Three iterations, one XOR each — the unrolling is visible in the node count.
    expect(module.nodes.filter((n) => n.op === 'xor')).toHaveLength(3);
    expect(trace.toArray().find((e) => e.kind === 'loop.unroll')?.detail).toMatchObject({ iterations: 3 });
  });

  it('computes parity by accumulating across iterations', () => {
    evaluatesAs(
      lines('def f(x: uint4) -> bit:', '    p = x[0]', '    for i in range(1, 4):', '        p = p ^ x[i]', '    return p'),
      (x) => ((x >> 0) ^ (x >> 1) ^ (x >> 2) ^ (x >> 3)) & 1,
    );
  });

  it('honours start, stop and step', () => {
    evaluatesAs(
      lines('def f(x: uint4) -> bit:', '    p = x[0]', '    for i in range(2, 4, 1):', '        p = p ^ x[i]', '    return p'),
      (x) => (x ^ (x >> 2) ^ (x >> 3)) & 1,
    );
  });

  it('builds nothing for a loop that runs zero times', () => {
    const module = lowerPython(lines('def f(a: bit) -> bit:', '    for i in range(0):', '        a = a & a', '    return a'));
    expect(module.nodes.filter((n) => n.op === 'and')).toEqual([]);
  });

  it('nests loops', () => {
    evaluatesAs(
      lines(
        'def f(x: uint2, y: uint2) -> bit:',
        '    p = False',
        '    for i in range(2):',
        '        for j in range(2):',
        '            p = p ^ (x[i] & y[j])',
        '    return p',
      ),
      (x, y) => {
        let p = 0;
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) p ^= ((x >> i) & 1) & ((y >> j) & 1);
        return p;
      },
    );
  });

  it('does not leak the loop variable past the loop', () => {
    // Python leaks it; keeping it out means a name cannot silently change from a bit
    // vector to an integer depending on whether a loop above it ran.
    const error = refusal(lines('def f(x: uint4) -> bit:', '    for i in range(2):', '        p = x[i]', '    return x[i]'));
    expect(error.message).toContain('"i" is not defined');
  });
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe('assertions', () => {
  it('checks a top-level assertion on every assignment', () => {
    const source = lines('def f(x: uint2, y: uint2) -> uint3:', '    s = x + y', '    assert s >= x', '    return s');
    const module = lowerPython(source);
    expect(module.assertions).toHaveLength(1);
    for (let a = 0; a < 2 ** module.inputs.length; a++) {
      expect(evaluate(module, assignmentToBits(a, module.inputs.length)).assertions['assert_line_3']).toBe(1);
    }
    // And the property check is the thing that would catch it if it did not hold.
    const result = compile({ kind: 'python', source });
    expect(result.report.checks.find((c) => c.id === 'property')!.status).toBe('passed');
    expect(result.report.passed).toBe(true);
  });

  it('turns an assertion inside a branch into an implication', () => {
    // `assert b` under `if a:` claims "b holds where a holds", not "b always holds". As a
    // bare claim it fails on a=0,b=0 — inputs that never reach the line — so this passing
    // is the whole point of threading the path condition.
    const source = lines('def f(a: bit, b: bit) -> bit:', '    if a:', '        assert b', '        r = b', '    else:', '        r = a', '    return r');
    const trace = new TraceRecorder();
    const module = lowerPython(source, { trace });
    expect(trace.toArray().some((e) => e.kind === 'assertion.guarded')).toBe(true);

    const guarded = module.assertions[0]!;
    for (let a = 0; a < 2 ** module.inputs.length; a++) {
      const bits = assignmentToBits(a, module.inputs.length);
      // Holds everywhere except where the branch is taken and the claim is false.
      const expected = bits[0] === 1 && bits[1] === 0 ? 0 : 1;
      expect(evaluate(module, bits).assertions[guarded.name]).toBe(expected);
    }
  });

  it('drops an assertion that is already true when the circuit is built', () => {
    const trace = new TraceRecorder();
    const module = lowerPython(lines('def f(a: bit) -> bit:', '    assert 1 < 2', '    return a'), { trace });
    expect(module.assertions).toEqual([]);
    expect(trace.toArray().some((e) => e.kind === 'assertion.constant')).toBe(true);
  });

  it('names assertions after the line they came from', () => {
    const module = lowerPython(lines('def f(a: bit, b: bit) -> bit:', '    assert a or not a', '    assert b or not b', '    return a'));
    expect(module.assertions.map((a) => a.name)).toEqual(['assert_line_2', 'assert_line_3']);
  });
});

// ---------------------------------------------------------------------------
// Names, widths and the module shape
// ---------------------------------------------------------------------------

describe('module shape', () => {
  it('names input and output wires after the source, least significant bit first', () => {
    const module = lowerPython(lines('def f(a: bit, x: uint3) -> uint2:', '    return x[0:2]'));
    expect(module.inputs.map((i) => i.name)).toEqual(['a', 'x[0]', 'x[1]', 'x[2]']);
    expect(module.outputs.map((o) => o.name)).toEqual(['out[0]', 'out[1]']);
  });

  it('takes output names from returned names, and falls back to a position otherwise', () => {
    expect(lowerPython(lines('def f(a: bit, b: bit) -> (bit, bit):', '    s = a ^ b', '    c = a & b', '    return s, c')).outputs.map((o) => o.name))
      .toEqual(['s', 'c']);
    expect(lowerPython(lines('def f(a: bit, b: bit) -> (bit, bit):', '    return a ^ b, a & b')).outputs.map((o) => o.name))
      .toEqual(['out0', 'out1']);
    expect(lowerPython(lines('def f(a: bit, b: bit) -> bit:', '    return a ^ b')).outputs.map((o) => o.name)).toEqual(['out']);
  });

  it('zero-extends a return that is narrower than its annotation', () => {
    evaluatesAs(lines('def f(a: bit) -> uint3:', '    return a'), (a) => a);
  });

  it('assigns in parallel, so a swap is a swap', () => {
    evaluatesAs(lines('def f(a: uint2, b: uint2) -> (uint2, uint2):', '    a, b = b, a', '    return a, b'), (a, b) => [b, a]);
  });

  it('applies an augmented assignment as the operator it spells', () => {
    evaluatesAs(
      lines('def f(x: uint3, y: uint3) -> uint3:', '    t: uint3 = x', '    t ^= y', '    t += 1', '    return t'),
      (x, y) => ((x ^ y) + 1) & 0b111,
    );
  });

  it('records what a widened input cost, in the user\'s own terms', () => {
    const trace = new TraceRecorder();
    lowerPython(lines('def f(x: uint3) -> uint3:', '    return x'), { trace });
    const entry = trace.toArray().find((e) => e.kind === 'input.declared')!;
    expect(entry.message).toContain('x[0]');
    expect(entry.message).toContain('least significant first');
  });

  it('records a truncation rather than letting it happen quietly', () => {
    const trace = new TraceRecorder();
    lowerPython(lines('def f(x: uint3, y: uint3) -> uint3:', '    s: uint3 = x + y', '    return s'), { trace });
    expect(trace.toArray().find((e) => e.kind === 'coerce.truncate')?.message).toContain('wraps');
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe('end to end', () => {
  it('compiles a half adder to a verified circuit, agreeing with the Boolean frontend', () => {
    const python = compile({
      kind: 'python',
      source: lines('def half_adder(a: bit, b: bit) -> (bit, bit):', '    return a ^ b, a & b'),
    });
    const boolean = compile({ kind: 'boolean', source: 'in a, b\nsum = a XOR b\ncarry = a AND b\n' });

    expect(python.report.passed).toBe(true);
    expect(python.report.checks.filter((c) => c.status === 'failed')).toEqual([]);
    // Different frontends, same circuit: the artifacts are byte-identical apart from the
    // spec hash in the header, which is what "the frontend is a notation" has to mean.
    expect(python.estimate.qubits).toBe(boolean.estimate.qubits);
    expect(python.estimate.gateCount).toBe(boolean.estimate.gateCount);
    expect(python.estimate.cliffordT.tCount).toBe(boolean.estimate.cliffordT.tCount);
  });

  it('compiles a 2-bit ripple-carry adder end to end and verifies it exhaustively', () => {
    const result = compile({ kind: 'python', source: lines('def add2(x: uint2, y: uint2) -> uint3:', '    return x + y') });
    expect(result.report.passed).toBe(true);
    const equivalence = result.report.checks.find((c) => c.id === 'simulation_equivalence')!;
    expect(equivalence.status).toBe('passed');
    // 16 assignments of two 2-bit inputs — well inside the exhaustive limit, so a sampled
    // result here would mean the coverage planner lost track of the input count.
    expect(equivalence.coverage).toMatchObject({ mode: 'exhaustive', checked: 16, space: 16 });
    expect(result.qasm).toContain('OPENQASM 3.0;');
  });

  it('fails check 6 and refuses the artifact when the budget is too small', () => {
    const result = compile({
      kind: 'python',
      source: lines('def add3(x: uint3, y: uint3) -> uint4:', '    return x + y'),
      budget: { maxQubits: 4 },
    });
    expect(result.report.passed).toBe(false);
    expect(result.report.checks.find((c) => c.id === 'resource')!.status).toBe('failed');
  });

  it('reports the same result on a second compile of the same source', () => {
    const source = lines('def cmp2(x: uint2, y: uint2) -> (bit, bit):', '    return x < y, x == y');
    const first = compile({ kind: 'python', source });
    const second = compile({ kind: 'python', source });
    expect(second.artifactHash).toBe(first.artifactHash);
    expect(second.specHash).toBe(first.specHash);
  });
});
