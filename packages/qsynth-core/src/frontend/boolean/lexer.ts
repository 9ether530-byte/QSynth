/**
 * Lexer for the Boolean expression frontend.
 *
 * Line structure is significant — one statement per line — so newlines are tokens rather
 * than whitespace. That keeps error spans tight: an unterminated expression is reported
 * at the end of the line the user wrote, not at the end of the file.
 *
 * Every token carries a span. Spans are what the workbench turns into inline markers, so
 * a token without one would be a marker the editor cannot place.
 */
import type { Span } from '../../errors.js';
import { parseError, QsynthError } from '../../errors.js';

export type TokenKind =
  | 'ident'
  | 'number'
  | 'keyword'
  | 'operator'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'colon'
  | 'equals'
  | 'newline'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** Canonical text: keywords and operators are upper-cased, identifiers are not. */
  readonly value: string;
  readonly span: Span;
}

/**
 * `out` is deliberately *not* a keyword: it is the name almost every specification gives
 * its first output, and a language that refuses `out = a AND b` to reserve a word it
 * never needed would be trading the common case for nothing.
 */
export const KEYWORDS: ReadonlySet<string> = new Set(['IN', 'LET', 'ASSERT']);

/** Word-form operators. Symbol forms are mapped to these in `symbolOperator`. */
export const WORD_OPERATORS: ReadonlySet<string> = new Set(['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR', 'NOT', 'MUX']);

const SYMBOL_OPERATORS: Record<string, string> = {
  '&': 'AND',
  '&&': 'AND',
  '|': 'OR',
  '||': 'OR',
  '^': 'XOR',
  '!': 'NOT',
  '~': 'NOT',
};

export const MAX_SOURCE_BYTES = 64 * 1024;

export function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_BYTES) {
    // Its own code, not a parse error: nothing is wrong with the syntax, and the API maps
    // this to "payload too large" rather than "bad request".
    throw new QsynthError(
      'SPEC_TOO_LARGE',
      `The specification is ${source.length} characters long; the limit is ${MAX_SOURCE_BYTES}.`,
      'Split the design into smaller modules.',
      { details: { length: source.length, limit: MAX_SOURCE_BYTES } },
    );
  }

  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const at = (): string => source[index]!;
  const span = (start: number, startLine: number, startColumn: number): Span => ({
    start,
    end: index,
    line: startLine,
    column: startColumn,
  });
  const push = (kind: TokenKind, value: string, start: number, startLine: number, startColumn: number) => {
    tokens.push({ kind, value, span: span(start, startLine, startColumn) });
  };
  const advance = (count = 1) => {
    for (let i = 0; i < count; i++) {
      if (source[index] === '\n') {
        line++;
        column = 1;
      } else {
        column++;
      }
      index++;
    }
  };

  while (index < source.length) {
    const start = index;
    const startLine = line;
    const startColumn = column;
    const ch = at();

    if (ch === '\n') {
      advance();
      push('newline', '\\n', start, startLine, startColumn);
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (index < source.length && at() !== '\n') advance();
      continue;
    }
    if (isIdentStart(ch)) {
      while (index < source.length && isIdentPart(at())) advance();
      const text = source.slice(start, index);
      const upper = text.toUpperCase();
      if (KEYWORDS.has(upper)) push('keyword', upper, start, startLine, startColumn);
      else if (WORD_OPERATORS.has(upper)) push('operator', upper, start, startLine, startColumn);
      else push('ident', text, start, startLine, startColumn);
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      while (index < source.length && at() >= '0' && at() <= '9') advance();
      const text = source.slice(start, index);
      if (text !== '0' && text !== '1') {
        throw parseError(
          `"${text}" is not a bit literal.`,
          'Only the literals 0 and 1 exist in a Boolean specification.',
          span(start, startLine, startColumn),
        );
      }
      push('number', text, start, startLine, startColumn);
      continue;
    }

    const two = source.slice(index, index + 2);
    if (SYMBOL_OPERATORS[two]) {
      advance(2);
      push('operator', SYMBOL_OPERATORS[two]!, start, startLine, startColumn);
      continue;
    }
    if (SYMBOL_OPERATORS[ch]) {
      advance();
      push('operator', SYMBOL_OPERATORS[ch]!, start, startLine, startColumn);
      continue;
    }

    const punctuation: Record<string, TokenKind> = {
      '(': 'lparen',
      ')': 'rparen',
      ',': 'comma',
      ':': 'colon',
      '=': 'equals',
    };
    const kind = punctuation[ch];
    if (kind) {
      advance();
      push(kind, ch, start, startLine, startColumn);
      continue;
    }

    advance();
    throw parseError(
      `Unexpected character "${ch}".`,
      'Boolean specifications use identifiers, the literals 0 and 1, the operators AND OR XOR NAND NOR XNOR NOT (or & | ^ !), MUX, parentheses and commas.',
      span(start, startLine, startColumn),
    );
  }

  tokens.push({ kind: 'eof', value: '', span: { start: index, end: index, line, column } });
  return tokens;
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}
