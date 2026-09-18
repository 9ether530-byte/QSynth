/**
 * Precedence-climbing parser for the Boolean frontend.
 *
 * Grammar (one statement per line, `#` to end of line is a comment):
 *
 *   statement := "in" ident ("," ident)*
 *              | "let" ident "=" expr           # internal value, not exported
 *              | "assert" [ident ":"] expr      # invariant, must hold on every input
 *              | ident "=" expr                 # output
 *
 *   expr      := xorExpr (("OR" | "NOR") xorExpr)*
 *   xorExpr   := andExpr (("XOR" | "XNOR") andExpr)*
 *   andExpr   := unary (("AND" | "NAND") unary)*
 *   unary     := "NOT" unary | primary
 *   primary   := ident | "0" | "1" | "(" expr ")" | "MUX" "(" expr "," expr "," expr ")"
 *
 * Precedence is OR < XOR < AND < NOT, matching every C-family language. NAND/NOR/XNOR sit
 * at the precedence of the operator they negate, and they are left-associative like the
 * others — `a NAND b NAND c` parses as `(a NAND b) NAND c`, which is *not* associative as
 * a function, so the parser is strict about grouping rather than clever about it.
 */
import type { Span } from '../../errors.js';
import { parseError } from '../../errors.js';
import { tokenize, type Token } from './lexer.js';

export type BinaryOp = 'AND' | 'OR' | 'XOR' | 'NAND' | 'NOR' | 'XNOR';

export type Expr =
  | { readonly kind: 'ref'; readonly name: string; readonly span: Span }
  | { readonly kind: 'const'; readonly value: 0 | 1; readonly span: Span }
  | { readonly kind: 'not'; readonly operand: Expr; readonly span: Span }
  | { readonly kind: 'binary'; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr; readonly span: Span }
  | { readonly kind: 'mux'; readonly selector: Expr; readonly ifOne: Expr; readonly ifZero: Expr; readonly span: Span };

export type Statement =
  | { readonly kind: 'inputs'; readonly names: readonly { readonly name: string; readonly span: Span }[]; readonly span: Span }
  | { readonly kind: 'let'; readonly name: string; readonly expr: Expr; readonly span: Span }
  | { readonly kind: 'output'; readonly name: string; readonly expr: Expr; readonly span: Span }
  | { readonly kind: 'assert'; readonly name: string; readonly expr: Expr; readonly span: Span };

export interface BooleanProgram {
  readonly statements: readonly Statement[];
}

/** Binary operators by precedence level, loosest first. */
const LEVELS: readonly (readonly BinaryOp[])[] = [
  ['OR', 'NOR'],
  ['XOR', 'XNOR'],
  ['AND', 'NAND'],
];

export function parseBoolean(source: string): BooleanProgram {
  const tokens = tokenize(source);
  let position = 0;
  let assertionCount = 0;

  const peek = (): Token => tokens[position]!;
  const next = (): Token => tokens[position++]!;
  const at = (kind: Token['kind'], value?: string): boolean => {
    const token = peek();
    return token.kind === kind && (value === undefined || token.value === value);
  };
  const expect = (kind: Token['kind'], description: string): Token => {
    if (!at(kind)) {
      throw parseError(
        `Expected ${description}, found ${describe(peek())}.`,
        'A statement is one of: "in a, b", "let t = expr", "assert expr", or "name = expr".',
        peek().span,
      );
    }
    return next();
  };
  const skipNewlines = () => {
    while (at('newline')) next();
  };

  const statements: Statement[] = [];

  skipNewlines();
  while (!at('eof')) {
    statements.push(parseStatement());
    if (!at('eof')) {
      if (!at('newline')) {
        throw parseError(
          `Expected the end of the line, found ${describe(peek())}.`,
          'Each statement occupies one line.',
          peek().span,
        );
      }
      skipNewlines();
    }
  }

  if (statements.length === 0) {
    throw parseError('The specification is empty.', 'Write at least one output, for example: out = a AND b');
  }

  return { statements };

  function parseStatement(): Statement {
    const start = peek().span;

    if (at('keyword', 'IN')) {
      next();
      const names: { name: string; span: Span }[] = [];
      for (;;) {
        const token = expect('ident', 'an input name');
        names.push({ name: token.value, span: token.span });
        if (at('comma')) {
          next();
          continue;
        }
        break;
      }
      return { kind: 'inputs', names, span: join(start, names[names.length - 1]!.span) };
    }

    if (at('keyword', 'LET')) {
      next();
      const name = expect('ident', 'a name for the value');
      expect('equals', '"="');
      const expr = parseExpr(0);
      return { kind: 'let', name: name.value, expr, span: join(start, expr.span) };
    }

    if (at('keyword', 'ASSERT')) {
      next();
      // `assert name: expr` names the invariant; `assert expr` gets a positional name so
      // the report can still refer to it.
      let name = `assertion_${++assertionCount}`;
      if (at('ident') && tokens[position + 1]?.kind === 'colon') {
        name = next().value;
        next();
      }
      const expr = parseExpr(0);
      return { kind: 'assert', name, expr, span: join(start, expr.span) };
    }

    const name = expect('ident', 'an output name');
    expect('equals', '"="');
    const expr = parseExpr(0);
    return { kind: 'output', name: name.value, expr, span: join(start, expr.span) };
  }

  function parseExpr(level: number): Expr {
    if (level >= LEVELS.length) return parseUnary();
    let left = parseExpr(level + 1);
    for (;;) {
      const token = peek();
      if (token.kind !== 'operator' || !LEVELS[level]!.includes(token.value as BinaryOp)) return left;
      next();
      const right = parseExpr(level + 1);
      left = { kind: 'binary', op: token.value as BinaryOp, left, right, span: join(left.span, right.span) };
    }
  }

  function parseUnary(): Expr {
    if (at('operator', 'NOT')) {
      const start = next().span;
      const operand = parseUnary();
      return { kind: 'not', operand, span: join(start, operand.span) };
    }
    return parsePrimary();
  }

  function parsePrimary(): Expr {
    const token = peek();

    if (token.kind === 'ident') {
      next();
      return { kind: 'ref', name: token.value, span: token.span };
    }
    if (token.kind === 'number') {
      next();
      return { kind: 'const', value: token.value === '1' ? 1 : 0, span: token.span };
    }
    if (token.kind === 'lparen') {
      next();
      const inner = parseExpr(0);
      const close = expect('rparen', '")"');
      return { ...inner, span: join(token.span, close.span) };
    }
    if (token.kind === 'operator' && token.value === 'MUX') {
      next();
      expect('lparen', '"(" after MUX');
      const selector = parseExpr(0);
      expect('comma', '"," after the MUX selector');
      const ifOne = parseExpr(0);
      expect('comma', '"," after the MUX value for 1');
      const ifZero = parseExpr(0);
      const close = expect('rparen', '")" closing MUX');
      return { kind: 'mux', selector, ifOne, ifZero, span: join(token.span, close.span) };
    }

    throw parseError(
      `Expected a value, found ${describe(token)}.`,
      'A value is a name, the literal 0 or 1, a parenthesised expression, or MUX(selector, if-one, if-zero).',
      token.span,
    );
  }
}

function join(a: Span, b: Span): Span {
  return { start: a.start, end: b.end, line: a.line, column: a.column };
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'eof':
      return 'the end of the specification';
    case 'newline':
      return 'the end of the line';
    default:
      return `"${token.value}"`;
  }
}
