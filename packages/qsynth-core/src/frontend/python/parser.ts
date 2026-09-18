/**
 * Recursive-descent parser for the Python subset.
 *
 * **The subset is a whitelist.** Every construct this parser accepts is written out in
 * the grammar below; anything else is refused with `UNSUPPORTED_CONSTRUCT`, naming what
 * the user wrote, where, and what the subset does support (US-10). That direction matters:
 * a blacklist would silently accept the next Python feature nobody thought to ban, and
 * "accepted but quietly means something else" is the failure this whole product exists to
 * prevent. The cost is that adding a feature means editing this file, which is the point.
 *
 * Grammar:
 *
 *   file      := funcdef
 *   funcdef   := "def" ident "(" [param ("," param)*] ")" "->" rettype ":" suite
 *   param     := ident ":" type
 *   type      := "bit" | "uint" N
 *   rettype   := type | "(" type ("," type)* ")" | "tuple" "[" type ("," type)* "]"
 *   suite     := NEWLINE INDENT stmt+ DEDENT
 *   stmt      := assign | augassign | if | for | assert | return | "pass"
 *   assign    := ident ("," ident)* [":" type] "=" expr ("," expr)*
 *   augassign := ident ("&="|"|="|"^="|"+="|"-="|"<<="|">>=") expr
 *   if        := "if" expr ":" suite ("elif" expr ":" suite)* ["else" ":" suite]
 *   for       := "for" ident "in" "range" "(" expr ["," expr ["," expr]] ")" ":" suite
 *   assert    := "assert" expr
 *   return    := "return" expr ("," expr)*
 *
 *   expr      := ternary
 *   ternary   := orTest ["if" orTest "else" ternary]
 *   orTest    := andTest ("or" andTest)*
 *   andTest   := notTest ("and" notTest)*
 *   notTest   := "not" notTest | comparison
 *   comparison:= bitOr (cmpop bitOr)*          # chained, as in Python: a < b < c
 *   bitOr     := bitXor ("|" bitXor)*
 *   bitXor    := bitAnd ("^" bitAnd)*
 *   bitAnd    := shift ("&" shift)*
 *   shift     := arith (("<<"|">>") arith)*
 *   arith     := unary (("+"|"-") unary)*
 *   unary     := "~" unary | primary trailer*
 *   trailer   := "[" expr [":" expr] "]"
 *   primary   := ident | number | "True" | "False" | "(" expr ")"
 *
 * Precedence follows Python exactly, including the part people get wrong: `&`, `^` and
 * `|` bind *tighter* than the comparisons, so `a & b == c` is `(a & b) == c`. Copying
 * Python here rather than choosing something more defensible is deliberate — a file that
 * parses as Python but means something else is worse than one that refuses to parse.
 */
import type { Span } from '../../errors.js';
import { parseError, unsupported, QsynthError } from '../../errors.js';
import { PY_RESERVED, tokenizePython, type PyToken } from './lexer.js';

export type PyBinOp = '&' | '|' | '^' | '+' | '-' | '<<' | '>>';
export type PyCmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type PyType =
  | { readonly kind: 'bit'; readonly span: Span }
  | { readonly kind: 'uint'; readonly width: number; readonly span: Span };

export interface PyParam {
  readonly name: string;
  readonly type: PyType;
  readonly span: Span;
}

export type PyExpr =
  | { readonly kind: 'name'; readonly name: string; readonly span: Span }
  | { readonly kind: 'num'; readonly value: number; readonly span: Span }
  | { readonly kind: 'bool'; readonly value: 0 | 1; readonly span: Span }
  | { readonly kind: 'invert'; readonly operand: PyExpr; readonly span: Span }
  | { readonly kind: 'not'; readonly operand: PyExpr; readonly span: Span }
  | { readonly kind: 'binary'; readonly op: PyBinOp; readonly left: PyExpr; readonly right: PyExpr; readonly span: Span }
  | { readonly kind: 'logical'; readonly op: 'and' | 'or'; readonly left: PyExpr; readonly right: PyExpr; readonly span: Span }
  | { readonly kind: 'compare'; readonly op: PyCmpOp; readonly left: PyExpr; readonly right: PyExpr; readonly span: Span }
  | { readonly kind: 'index'; readonly value: PyExpr; readonly index: PyExpr; readonly span: Span }
  | { readonly kind: 'slice'; readonly value: PyExpr; readonly lower: PyExpr | null; readonly upper: PyExpr | null; readonly span: Span }
  | { readonly kind: 'ternary'; readonly test: PyExpr; readonly ifTrue: PyExpr; readonly ifFalse: PyExpr; readonly span: Span };

export interface PyTarget {
  readonly name: string;
  readonly span: Span;
}

export type PyStmt =
  | {
      readonly kind: 'assign';
      readonly targets: readonly PyTarget[];
      readonly annotation: PyType | null;
      readonly values: readonly PyExpr[];
      readonly span: Span;
    }
  | { readonly kind: 'aug'; readonly target: PyTarget; readonly op: PyBinOp; readonly value: PyExpr; readonly span: Span }
  | { readonly kind: 'if'; readonly test: PyExpr; readonly body: readonly PyStmt[]; readonly orelse: readonly PyStmt[]; readonly span: Span }
  | {
      readonly kind: 'for';
      readonly name: string;
      readonly nameSpan: Span;
      readonly args: readonly PyExpr[];
      readonly body: readonly PyStmt[];
      readonly span: Span;
    }
  | { readonly kind: 'assert'; readonly test: PyExpr; readonly span: Span }
  | { readonly kind: 'return'; readonly values: readonly PyExpr[]; readonly span: Span }
  | { readonly kind: 'pass'; readonly span: Span };

export interface PyFunction {
  readonly name: string;
  readonly params: readonly PyParam[];
  readonly returns: readonly PyType[];
  /** True when the annotation was a tuple, so `-> (bit,)` stays distinct from `-> bit`. */
  readonly returnsTuple: boolean;
  readonly body: readonly PyStmt[];
  readonly span: Span;
}

/**
 * The widest bounded integer a single value may have. The real ceiling is the module's
 * 20-input limit, which this cannot see; 16 is here so that `uint9999` is refused at the
 * annotation rather than after allocating nine thousand nodes.
 */
export const MAX_UINT_WIDTH = 16;

/** Quoted back at the user by every refusal in this file. */
const SUPPORTED = [
  'def with bit and uintN parameters',
  'assignment',
  'if/elif/else',
  'for over range() with constant bounds',
  'assert',
  'return',
  '& | ^ ~ and or not',
  '+ - << >>',
  '== != < <= > >=',
  'indexing and slicing',
];

const AUG_OPS: Record<string, PyBinOp> = {
  '&=': '&', '|=': '|', '^=': '^', '+=': '+', '-=': '-', '<<=': '<<', '>>=': '>>',
};

const CMP_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=']);

/** Operators the subset does not implement, and what to say about each. */
const REFUSED_OPS: Record<string, { what: string; hint: string }> = {
  '*': {
    what: 'Multiplication',
    hint:
      'Multiplication expands to one adder per bit of the multiplier, which puts even small operands ' +
      'past the verification budget. Write the partial products with << and + if you need it.',
  },
  '/': { what: 'Division', hint: 'There is no division in the subset. Use >> for a shift by a constant.' },
  '//': { what: 'Floor division', hint: 'Use >> for a shift by a constant.' },
  '%': { what: 'The modulo operator', hint: 'Mask with & instead: x % 8 is x & 7.' },
  '**': { what: 'Exponentiation', hint: 'Use << for a shift by a constant.' },
  '@': { what: 'The decorator and matrix-multiply operator', hint: '' },
  ';': { what: 'Statements separated by a semicolon', hint: 'Put each statement on its own line.' },
};

export function parsePython(source: string): PyFunction {
  const tokens = tokenizePython(source);
  let position = 0;

  const peek = (): PyToken => tokens[position]!;
  const next = (): PyToken => tokens[position++]!;
  const at = (kind: PyToken['kind'], value?: string): boolean => {
    const token = peek();
    return token.kind === kind && (value === undefined || token.value === value);
  };
  const accept = (kind: PyToken['kind'], value?: string): PyToken | null => (at(kind, value) ? next() : null);
  const expect = (kind: PyToken['kind'], value: string | undefined, description: string): PyToken => {
    if (!at(kind, value)) {
      refuseIfKnown(peek());
      throw parseError(`Expected ${description}, found ${describe(peek())}.`, hintFor(peek()), peek().span);
    }
    return next();
  };
  const skipNewlines = () => {
    while (at('newline')) next();
  };

  /**
   * If the token is something the subset knowingly leaves out, refuse it by name and
   * stop. Reaching this from several places is deliberate: an unsupported operator can
   * surface as "expected the end of the line", and reporting a stray token where the user
   * wrote `x * y` tells them nothing about why it was rejected.
   */
  function refuseIfKnown(token: PyToken): void {
    if (token.kind === 'keyword' && PY_RESERVED.has(token.value)) {
      throw unsupported(reservedDescription(token.value), SUPPORTED, token.span);
    }
    const refused = token.kind === 'op' ? REFUSED_OPS[token.value] : undefined;
    if (refused) {
      throw new QsynthError('UNSUPPORTED_CONSTRUCT', `${refused.what} is not supported.`,
        refused.hint || `The subset accepts: ${SUPPORTED.join(', ')}.`,
        { span: token.span, details: { construct: refused.what, operator: token.value, supported: SUPPORTED } });
    }
  }

  const refuse = (token: PyToken): never => {
    refuseIfKnown(token);
    throw parseError(`Unexpected ${describe(token)}.`, hintFor(token), token.span);
  };

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  const parseType = (): PyType => {
    const token = peek();
    if (token.kind !== 'ident') {
      throw parseError(
        `Expected a type annotation, found ${describe(token)}.`,
        'Annotate with "bit" for a single bit or "uintN" for an N-bit unsigned integer, for example "uint4".',
        token.span,
      );
    }
    next();
    if (token.value === 'bit') return { kind: 'bit', span: token.span };
    const match = /^uint(\d+)$/.exec(token.value);
    if (!match) {
      throw parseError(
        `"${token.value}" is not a type in the subset.`,
        'The types are "bit" and "uintN" — for example "uint4". Python\'s int is unbounded, which has no ' +
          'finite circuit, so every integer here carries its width in its name.',
        token.span,
      );
    }
    const width = Number(match[1]);
    if (width < 1 || width > MAX_UINT_WIDTH) {
      throw parseError(
        `"uint${width}" is out of range; widths run from 1 to ${MAX_UINT_WIDTH}.`,
        `A wider value would need more than ${MAX_UINT_WIDTH} qubits for one operand alone.`,
        token.span,
      );
    }
    return { kind: 'uint', width, span: token.span };
  };

  const parseReturnType = (): { types: PyType[]; tuple: boolean } => {
    if (accept('op', '(')) {
      const types = [parseType()];
      while (accept('op', ',')) {
        if (at('op', ')')) break;
        types.push(parseType());
      }
      expect('op', ')', '")" to close the return type');
      return { types, tuple: true };
    }
    if (at('ident', 'tuple')) {
      next();
      expect('op', '[', '"[" after "tuple"');
      const types = [parseType()];
      while (accept('op', ',')) types.push(parseType());
      expect('op', ']', '"]" to close the return type');
      return { types, tuple: true };
    }
    return { types: [parseType()], tuple: false };
  };

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  const spanFrom = (start: Span, end: Span): Span => ({
    start: start.start,
    end: end.end,
    line: start.line,
    column: start.column,
  });

  const parseExpr = (): PyExpr => parseTernary();

  const parseTernary = (): PyExpr => {
    const body = parseOrTest();
    if (!at('keyword', 'if')) return body;
    next();
    const test = parseOrTest();
    if (!at('keyword', 'else')) {
      throw parseError(
        'A conditional expression needs an "else" branch.',
        'Write "a if cond else b". Without the else there is no value when the condition is false, and ' +
          'a circuit has to produce a bit either way.',
        peek().span,
      );
    }
    next();
    const orelse = parseTernary();
    return { kind: 'ternary', test, ifTrue: body, ifFalse: orelse, span: spanFrom(body.span, orelse.span) };
  };

  const parseOrTest = (): PyExpr => {
    let left = parseAndTest();
    while (at('keyword', 'or')) {
      next();
      const right = parseAndTest();
      left = { kind: 'logical', op: 'or', left, right, span: spanFrom(left.span, right.span) };
    }
    return left;
  };

  const parseAndTest = (): PyExpr => {
    let left = parseNotTest();
    while (at('keyword', 'and')) {
      next();
      const right = parseNotTest();
      left = { kind: 'logical', op: 'and', left, right, span: spanFrom(left.span, right.span) };
    }
    return left;
  };

  const parseNotTest = (): PyExpr => {
    if (at('keyword', 'not')) {
      const token = next();
      const operand = parseNotTest();
      return { kind: 'not', operand, span: spanFrom(token.span, operand.span) };
    }
    return parseComparison();
  };

  const parseComparison = (): PyExpr => {
    let left = parseBitOr();
    let chain: PyExpr | null = null;
    while (at('op') && CMP_OPS.has(peek().value)) {
      const op = next().value as PyCmpOp;
      const right = parseBitOr();
      // Python chains: `a < b < c` means `a < b and b < c`, with `b` evaluated once.
      // Rebuilding the reference rather than the value is safe here because every
      // expression in the subset is pure — there is nothing to evaluate twice.
      const link: PyExpr = { kind: 'compare', op, left, right, span: spanFrom(left.span, right.span) };
      chain = chain === null ? link : { kind: 'logical', op: 'and', left: chain, right: link, span: spanFrom(chain.span, link.span) };
      left = right;
    }
    return chain ?? left;
  };

  const binaryLevel = (ops: readonly PyBinOp[], below: () => PyExpr) => (): PyExpr => {
    let left = below();
    for (;;) {
      const token = peek();
      if (token.kind !== 'op' || !ops.includes(token.value as PyBinOp)) break;
      next();
      const right = below();
      left = { kind: 'binary', op: token.value as PyBinOp, left, right, span: spanFrom(left.span, right.span) };
    }
    return left;
  };

  const parseUnary = (): PyExpr => {
    const token = peek();
    if (token.kind === 'op' && token.value === '~') {
      next();
      const operand = parseUnary();
      return { kind: 'invert', operand, span: spanFrom(token.span, operand.span) };
    }
    if (token.kind === 'op' && token.value === '-') {
      next();
      throw unsupported('Unary minus', SUPPORTED, token.span);
    }
    if (token.kind === 'op' && token.value === '+') {
      next();
      return parseUnary();
    }
    return parseTrailers(parsePrimary());
  };

  const parseArith = binaryLevel(['+', '-'], parseUnary);
  const parseShift = binaryLevel(['<<', '>>'], parseArith);
  const parseBitAnd = binaryLevel(['&'], parseShift);
  const parseBitXor = binaryLevel(['^'], parseBitAnd);
  const parseBitOr = binaryLevel(['|'], parseBitXor);

  function parseTrailers(base: PyExpr): PyExpr {
    let value = base;
    for (;;) {
      if (at('op', '[')) {
        const open = next();
        const lower = at('op', ':') ? null : parseExpr();
        if (accept('op', ':')) {
          const upper = at('op', ']') ? null : parseExpr();
          const close = expect('op', ']', '"]" to close the slice');
          value = { kind: 'slice', value, lower, upper, span: spanFrom(value.span, close.span) };
          continue;
        }
        if (lower === null) throw parseError('An index is missing.', 'Write x[0] or x[0:2].', open.span);
        const close = expect('op', ']', '"]" to close the index');
        value = { kind: 'index', value, index: lower, span: spanFrom(value.span, close.span) };
        continue;
      }
      if (at('op', '(')) {
        throw unsupported(
          'Calling a function',
          SUPPORTED,
          peek().span,
        );
      }
      if (at('op', '.')) {
        throw unsupported('Attribute access', SUPPORTED, peek().span);
      }
      return value;
    }
  }

  function parsePrimary(): PyExpr {
    const token = peek();
    if (token.kind === 'ident') {
      next();
      return { kind: 'name', name: token.value, span: token.span };
    }
    if (token.kind === 'number') {
      next();
      return { kind: 'num', value: parseNumber(token), span: token.span };
    }
    if (token.kind === 'keyword' && (token.value === 'True' || token.value === 'False')) {
      next();
      return { kind: 'bool', value: token.value === 'True' ? 1 : 0, span: token.span };
    }
    if (token.kind === 'op' && token.value === '(') {
      next();
      const inner = parseExpr();
      if (at('op', ',')) {
        throw unsupported('A tuple in an expression', SUPPORTED, token.span);
      }
      expect('op', ')', '")" to close the group');
      return inner;
    }
    if (token.kind === 'op' && token.value === '[') {
      throw unsupported('A list literal', SUPPORTED, token.span);
    }
    return refuse(token);
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  const parseSuite = (what: string): PyStmt[] => {
    expect('op', ':', `":" after the ${what}`);
    if (!at('newline')) {
      throw parseError(
        `The body of the ${what} must be on its own indented line.`,
        'One-line bodies like "if a: b = 1" are not accepted; the indented form is the only one, so ' +
          'block structure always reads the same way.',
        peek().span,
      );
    }
    skipNewlines();
    if (!at('indent')) {
      throw parseError(
        `The body of the ${what} is empty or not indented.`,
        'Indent the body by four spaces.',
        peek().span,
      );
    }
    next();
    const body: PyStmt[] = [];
    while (!at('dedent') && !at('eof')) {
      skipNewlines();
      if (at('dedent') || at('eof')) break;
      body.push(parseStatement());
    }
    accept('dedent');
    if (body.length === 0) {
      throw parseError(`The body of the ${what} is empty.`, 'Write "pass" if it is deliberately empty.', peek().span);
    }
    return body;
  };

  function parseStatement(): PyStmt {
    const token = peek();

    if (token.kind === 'keyword') {
      switch (token.value) {
        case 'if':
          return parseIf();
        case 'for':
          return parseFor();
        case 'assert': {
          next();
          const test = parseExpr();
          endOfStatement();
          return { kind: 'assert', test, span: spanFrom(token.span, test.span) };
        }
        case 'return': {
          next();
          const values = [parseExpr()];
          while (accept('op', ',')) values.push(parseExpr());
          endOfStatement();
          return { kind: 'return', values, span: spanFrom(token.span, values[values.length - 1]!.span) };
        }
        case 'pass':
          next();
          endOfStatement();
          return { kind: 'pass', span: token.span };
        case 'def':
          throw unsupported(
            'A nested function definition',
            SUPPORTED,
            token.span,
          );
        case 'elif':
        case 'else':
          throw parseError(
            `"${token.value}" does not follow an "if".`,
            'Check the indentation of the "if" this was meant to belong to.',
            token.span,
          );
        default:
          return refuse(token);
      }
    }

    if (token.kind !== 'ident') return refuse(token);

    // Assignment. The targets are read first because `a, b = ...` and `a: uint4 = ...`
    // only diverge after the name.
    const targets: PyTarget[] = [{ name: token.value, span: token.span }];
    next();

    if (at('op') && AUG_OPS[peek().value] !== undefined) {
      const opToken = next();
      const value = parseExpr();
      endOfStatement();
      return {
        kind: 'aug',
        target: targets[0]!,
        op: AUG_OPS[opToken.value]!,
        value,
        span: spanFrom(token.span, value.span),
      };
    }

    let annotation: PyType | null = null;
    if (accept('op', ':')) annotation = parseType();

    while (accept('op', ',')) {
      const name = expect('ident', undefined, 'another name to assign to');
      targets.push({ name: name.value, span: name.span });
    }

    if (at('op', '[')) {
      throw unsupported(
        'Assigning to an index',
        SUPPORTED,
        peek().span,
      );
    }
    expect('op', '=', '"=" — a statement here must assign to a name');

    const values = [parseExpr()];
    while (accept('op', ',')) values.push(parseExpr());
    endOfStatement();
    return { kind: 'assign', targets, annotation, values, span: spanFrom(token.span, values[values.length - 1]!.span) };
  }

  function parseIf(): PyStmt {
    // `elif` lands here too — see the recursion below, which turns it into an `if` in the
    // else-suite so the lowering has one branch construct rather than two spellings.
    const token = at('keyword', 'elif') ? next() : expect('keyword', 'if', '"if"');
    const test = parseExpr();
    const body = parseSuite(token.value === 'elif' ? 'elif' : 'if');
    skipNewlines();

    let orelse: PyStmt[] = [];
    if (at('keyword', 'elif')) {
      // `elif` is an `if` in the else-suite. Desugaring here means the lowering has one
      // branch construct to handle rather than two spellings of the same thing.
      orelse = [parseIf()];
    } else if (at('keyword', 'else')) {
      next();
      orelse = parseSuite('else');
    }
    return { kind: 'if', test, body, orelse, span: spanFrom(token.span, test.span) };
  }

  function parseFor(): PyStmt {
    const token = expect('keyword', 'for', '"for"');
    const name = expect('ident', undefined, 'the loop variable');
    if (!at('keyword', 'in')) {
      throw parseError(`Expected "in" after the loop variable, found ${describe(peek())}.`, 'Write "for i in range(4):".', peek().span);
    }
    next();
    if (!at('keyword', 'range')) {
      throw unsupported(
        `Iterating over ${describe(peek())}`,
        SUPPORTED,
        peek().span,
      );
    }
    next();
    expect('op', '(', '"(" after "range"');
    const args = [parseExpr()];
    while (accept('op', ',')) args.push(parseExpr());
    expect('op', ')', '")" to close range(...)');
    if (args.length > 3) {
      throw parseError('range() takes at most three arguments.', 'Write range(stop), range(start, stop) or range(start, stop, step).', token.span);
    }
    const body = parseSuite('for');
    return { kind: 'for', name: name.value, nameSpan: name.span, args, body, span: spanFrom(token.span, name.span) };
  }

  function endOfStatement(): void {
    if (at('newline') || at('eof') || at('dedent')) {
      accept('newline');
      return;
    }
    refuseIfKnown(peek());
    throw parseError(`Expected the end of the line, found ${describe(peek())}.`, hintFor(peek()), peek().span);
  }

  // -------------------------------------------------------------------------
  // The file
  // -------------------------------------------------------------------------

  skipNewlines();
  if (!at('keyword', 'def')) {
    throw parseError(
      `A Python specification starts with a function definition, but this file starts with ${describe(peek())}.`,
      'Write, for example:\n  def half_adder(a: bit, b: bit) -> (bit, bit):\n      return a ^ b, a & b',
      peek().span,
    );
  }
  const defToken = next();
  const nameToken = expect('ident', undefined, 'the function name');
  expect('op', '(', '"(" after the function name');

  const params: PyParam[] = [];
  if (!at('op', ')')) {
    for (;;) {
      const paramName = expect('ident', undefined, 'a parameter name');
      if (!at('op', ':')) {
        throw parseError(
          `Parameter "${paramName.value}" has no type annotation.`,
          'Every parameter needs one — "bit" or "uintN" — because the annotation is what fixes how many ' +
            'qubits the parameter costs. Write "def f(a: bit, b: uint4):".',
          paramName.span,
        );
      }
      next();
      const type = parseType();
      params.push({ name: paramName.value, type, span: paramName.span });
      if (!accept('op', ',')) break;
      if (at('op', ')')) break;
    }
  }
  expect('op', ')', '")" to close the parameter list');

  if (!at('op', '->')) {
    throw parseError(
      'The function has no return type annotation.',
      'Write "-> bit", "-> uint4", or "-> (bit, bit)" for several outputs. The annotation fixes the width ' +
        'of each output, which a circuit has to know before it can be built.',
      peek().span,
    );
  }
  next();
  const { types: returns, tuple: returnsTuple } = parseReturnType();
  const body = parseSuite('function');

  skipNewlines();
  if (!at('eof')) {
    throw parseError(
      `A specification holds exactly one function, but there is more after it: ${describe(peek())}.`,
      'Compile each function as its own specification.',
      peek().span,
    );
  }

  return {
    name: nameToken.value,
    params,
    returns,
    returnsTuple,
    body,
    span: spanFrom(defToken.span, nameToken.span),
  };
}

function parseNumber(token: PyToken): number {
  const text = token.value.replace(/_/g, '');
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    throw parseError(`"${token.value}" is not a non-negative integer.`, 'Integer literals only.', token.span);
  }
  if (value > 2 ** 32) {
    throw parseError(`${token.value} is too large.`, `Literals must fit in ${MAX_UINT_WIDTH} bits when used as a value.`, token.span);
  }
  return value;
}

function reservedDescription(word: string): string {
  const descriptions: Record<string, string> = {
    while: 'A while loop',
    class: 'A class definition',
    import: 'An import',
    from: 'An import',
    lambda: 'A lambda',
    try: 'A try block',
    except: 'An except block',
    finally: 'A finally block',
    with: 'A with block',
    yield: 'yield',
    global: 'A global declaration',
    nonlocal: 'A nonlocal declaration',
    del: 'del',
    raise: 'raise',
    async: 'async',
    await: 'await',
    match: 'A match statement',
    case: 'A case clause',
    is: 'The "is" operator',
    None: 'None',
    break: 'break',
    continue: 'continue',
    as: '"as"',
  };
  return descriptions[word] ?? `"${word}"`;
}

function describe(token: PyToken): string {
  switch (token.kind) {
    case 'eof':
      return 'the end of the file';
    case 'newline':
      return 'the end of the line';
    case 'indent':
      return 'an indented line';
    case 'dedent':
      return 'the end of the block';
    case 'ident':
      return `"${token.value}"`;
    case 'number':
      return `the number ${token.value}`;
    default:
      return `"${token.value}"`;
  }
}

function hintFor(token: PyToken): string {
  const refused = REFUSED_OPS[token.value];
  if (token.kind === 'op' && refused) return refused.hint || `${refused.what} is not part of the subset.`;
  return `The subset accepts: ${SUPPORTED.join(', ')}.`;
}
