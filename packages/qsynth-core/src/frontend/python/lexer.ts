/**
 * Lexer for the Python subset.
 *
 * Two things make this different from the Boolean frontend's lexer, and both come from
 * the language being real Python rather than a notation of our own.
 *
 * **Indentation is syntax.** Block structure is carried by `indent` and `dedent` tokens
 * synthesised here from a column stack, so the parser can treat a suite like any other
 * bracketed construct. A dedent that lands between two levels — the classic
 * half-reindented block — is reported as its own error naming both levels, because
 * "unexpected indent" is the one Python message everybody has had to guess at.
 *
 * Tabs are refused outright rather than expanded to some assumed width. Python 3 refuses
 * them too when they are mixed with spaces, and a file that renders differently in the
 * editor than it compiles in is the worst failure mode available here.
 *
 * **The lexer recognises more than the parser accepts.** `while`, `import`, `lambda` and
 * the rest are tokenised as keywords, and `**`, `//`, `@` as operators, so the parser can
 * refuse them by name with `UNSUPPORTED_CONSTRUCT` (US-10). A lexer that simply failed on
 * an unknown character would report a stray symbol where the user wrote a loop.
 */
import type { Span } from '../../errors.js';
import { parseError, QsynthError } from '../../errors.js';
import { MAX_SOURCE_BYTES } from '../boolean/lexer.js';

export type PyTokenKind = 'ident' | 'number' | 'keyword' | 'op' | 'newline' | 'indent' | 'dedent' | 'eof';

export interface PyToken {
  readonly kind: PyTokenKind;
  readonly value: string;
  readonly span: Span;
}

/** Keywords the subset implements. */
export const PY_KEYWORDS: ReadonlySet<string> = new Set([
  'def', 'return', 'if', 'elif', 'else', 'for', 'in', 'range', 'assert',
  'and', 'or', 'not', 'True', 'False', 'pass',
]);

/**
 * Python keywords the subset does not implement. Listed rather than inferred so the
 * parser's refusal can name the construct the user actually wrote: `while` is "a while
 * loop", not "an unexpected identifier".
 */
export const PY_RESERVED: ReadonlySet<string> = new Set([
  'while', 'class', 'import', 'from', 'as', 'lambda', 'try', 'except', 'finally',
  'with', 'yield', 'global', 'nonlocal', 'del', 'raise', 'async', 'await',
  'match', 'case', 'is', 'None', 'break', 'continue',
]);

/** Longest first — `<<=` must win over `<<`, which must win over `<`. */
const OPERATORS: readonly string[] = [
  '**=', '//=', '<<=', '>>=',
  '**', '//', '->', '==', '!=', '<=', '>=', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '<', '>', '=',
  '(', ')', '[', ']', '{', '}', ',', ':', '.', '@', ';',
];

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

export function tokenizePython(source: string): PyToken[] {
  if (source.length > MAX_SOURCE_BYTES) {
    throw new QsynthError(
      'SPEC_TOO_LARGE',
      `The specification is ${source.length} characters long; the limit is ${MAX_SOURCE_BYTES}.`,
      'Split the design into smaller functions and compile them separately.',
      { details: { length: source.length, limit: MAX_SOURCE_BYTES } },
    );
  }

  const tokens: PyToken[] = [];
  const indents: number[] = [0];
  let index = 0;
  let line = 1;
  let lineStart = 0;
  /** Bracket nesting. Inside brackets a newline is whitespace, as in Python. */
  let depth = 0;
  let atLineStart = true;

  const column = () => index - lineStart + 1;
  const push = (kind: PyTokenKind, value: string, start: number, startLine: number, startColumn: number) => {
    tokens.push({ kind, value, span: { start, end: index, line: startLine, column: startColumn } });
  };
  const here = (): Span => ({ start: index, end: index + 1, line, column: column() });

  const newline = () => {
    const start = index;
    const startColumn = column();
    index++;
    if (depth === 0) push('newline', '\n', start, line, startColumn);
    line++;
    lineStart = index;
    atLineStart = depth === 0;
  };

  while (index < source.length) {
    if (atLineStart) {
      atLineStart = false;
      const start = index;
      let width = 0;
      while (index < source.length) {
        const c = source[index]!;
        if (c === ' ') { width++; index++; continue; }
        if (c === '\t') {
          throw parseError(
            'This line is indented with a tab.',
            'Indent with spaces. A file that mixes tabs and spaces renders differently in different ' +
              'editors, so the block structure you see would not be the block structure that compiles.',
            { start: index, end: index + 1, line, column: column() },
          );
        }
        break;
      }
      // A blank or comment-only line carries no block structure: Python ignores its
      // indentation entirely, and so must we, or a stray comment would close a suite.
      const rest = source[index];
      if (rest === undefined) break;
      if (rest === '\n' || rest === '\r' || rest === '#') continue;

      const top = indents[indents.length - 1]!;
      if (width > top) {
        indents.push(width);
        push('indent', ' '.repeat(width), start, line, 1);
      } else if (width < top) {
        while (indents.length > 1 && width < indents[indents.length - 1]!) {
          indents.pop();
          push('dedent', '', start, line, 1);
        }
        if (width !== indents[indents.length - 1]!) {
          throw parseError(
            `This line is indented ${width} space(s), which does not close any open block.`,
            `The enclosing blocks start at column ${indents.map((n) => n + 1).join(', ')}. ` +
              'Line up the line with one of them.',
            { start, end: index, line, column: 1 },
          );
        }
      }
      continue;
    }

    const c = source[index]!;

    if (c === '\r') { index++; continue; }
    if (c === '\n') { newline(); continue; }
    if (c === ' ') { index++; continue; }
    if (c === '\t') { index++; continue; } // Mid-line tabs are only spacing; indentation is checked above.

    if (c === '#') {
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }

    if (c === '\\' && source[index + 1] === '\n') {
      index += 2;
      line++;
      lineStart = index;
      continue;
    }

    if (isDigit(c)) {
      const start = index;
      const startColumn = column();
      // 0b1011 and 0x1f are how bit patterns get written; refusing them would make the
      // one notation this language is for the one notation it lacks.
      if (c === '0' && (source[index + 1] === 'b' || source[index + 1] === 'x' || source[index + 1] === 'o')) {
        index += 2;
        while (index < source.length && (isIdentPart(source[index]!))) index++;
      } else {
        while (index < source.length && (isDigit(source[index]!) || source[index] === '_')) index++;
        if (source[index] === '.' || source[index] === 'e' || source[index] === 'E') {
          throw parseError(
            'Floating-point numbers are not supported.',
            'Every value in a QSYNTH specification is a bit or a bounded unsigned integer.',
            { start, end: index + 1, line, column: startColumn },
          );
        }
      }
      push('number', source.slice(start, index), start, line, startColumn);
      continue;
    }

    if (isIdentStart(c)) {
      const start = index;
      const startColumn = column();
      while (index < source.length && isIdentPart(source[index]!)) index++;
      const text = source.slice(start, index);
      push(PY_KEYWORDS.has(text) || PY_RESERVED.has(text) ? 'keyword' : 'ident', text, start, line, startColumn);
      continue;
    }

    if (c === '"' || c === "'") {
      throw parseError(
        'String literals are not supported.',
        'A QSYNTH specification describes bits, so there is nothing a string could name. ' +
          'Use a comment if you meant to document the line.',
        here(),
      );
    }

    const op = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (op === undefined) {
      throw parseError(
        `Unexpected character "${c}".`,
        'The subset uses & | ^ ~ + - << >> and the comparison operators.',
        here(),
      );
    }
    const start = index;
    const startColumn = column();
    if (op === '(' || op === '[' || op === '{') depth++;
    if (op === ')' || op === ']' || op === '}') depth = Math.max(0, depth - 1);
    index += op.length;
    push('op', op, start, line, startColumn);
  }

  // A file that does not end in a newline still ends its last statement.
  if (tokens.length > 0 && tokens[tokens.length - 1]!.kind !== 'newline') {
    push('newline', '\n', index, line, column());
  }
  while (indents.length > 1) {
    indents.pop();
    push('dedent', '', index, line, 1);
  }
  push('eof', '', index, line, column());
  return tokens;
}
