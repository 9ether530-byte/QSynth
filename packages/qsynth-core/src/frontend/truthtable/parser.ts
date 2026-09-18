/**
 * Truth-table frontend — parser.
 *
 * Format:
 *
 *   # a full adder
 *   a b cin | sum cout
 *   0 0 0   | 0 0
 *   0 0 1   | 1 0
 *   ...
 *
 * The header names the inputs, then `|` (or `->`), then the outputs. Each row gives one
 * bit per input and one per output. Cells may be separated by spaces or commas, or run
 * together (`001 | 10`), because both styles show up in the textbooks people copy from.
 *
 * An output cell may be `-`, meaning the specification does not care what the circuit
 * produces there. Rows may also be omitted entirely. Both cases are recorded as
 * don't-care assignments and reported in the trace — never silently filled with 0, which
 * would turn an unstated requirement into a verified one.
 */
import type { Span } from '../../errors.js';
import { invalidSpec, parseError, QsynthError } from '../../errors.js';
import { EXHAUSTIVE_INPUT_LIMIT } from '../../ir/classical.js';
import { MAX_SOURCE_BYTES } from '../boolean/lexer.js';

export type Cell = 0 | 1 | null;

export interface TruthRow {
  /** Input bits as an assignment index; input 0 is the least significant bit. */
  readonly assignment: number;
  readonly inputBits: readonly (0 | 1)[];
  /** One per output; null is an explicit don't-care. */
  readonly outputs: readonly Cell[];
  readonly span: Span;
}

export interface TruthTable {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly rows: readonly TruthRow[];
  /** Assignments with no row at all, or a row containing a don't-care cell. */
  readonly dontCare: readonly number[];
}

export function parseTruthTable(source: string): TruthTable {
  if (source.length > MAX_SOURCE_BYTES) {
    throw new QsynthError(
      'SPEC_TOO_LARGE',
      `The table is ${source.length} characters long; the limit is ${MAX_SOURCE_BYTES}.`,
      'Split the design into smaller tables.',
      { details: { length: source.length, limit: MAX_SOURCE_BYTES } },
    );
  }

  const lines = splitLines(source);
  const content = lines.filter((line) => line.text.trim().length > 0);
  if (content.length === 0) {
    throw parseError('The table is empty.', 'Start with a header line, for example: a b | out');
  }

  const header = parseHeader(content[0]!);
  if (header.inputs.length > EXHAUSTIVE_INPUT_LIMIT) {
    throw invalidSpec(
      `A truth table may declare at most ${EXHAUSTIVE_INPUT_LIMIT} inputs; this one declares ${header.inputs.length}.`,
      `A table with ${header.inputs.length} inputs has ${2 ** header.inputs.length} rows. Above ${EXHAUSTIVE_INPUT_LIMIT} inputs, describe the circuit as a Boolean expression instead.`,
      { limit: EXHAUSTIVE_INPUT_LIMIT, declared: header.inputs.length },
    );
  }

  const rows: TruthRow[] = [];
  const seen = new Map<number, Span>();

  for (const line of content.slice(1)) {
    const { left, right } = splitSides(line);
    const inputCells = parseCells(left, line.span, header.inputs.length, 'input');
    const outputCells = parseCells(right, line.span, header.outputs.length, 'output');

    for (let i = 0; i < inputCells.length; i++) {
      if (inputCells[i] === null) {
        throw parseError(
          `Input "${header.inputs[i]}" is "-" on this row.`,
          'Don\'t-care applies to outputs only. Leave the whole row out instead, or write both 0 and 1 rows.',
          line.span,
        );
      }
    }

    const inputBits = inputCells as (0 | 1)[];
    let assignment = 0;
    for (let i = 0; i < inputBits.length; i++) if (inputBits[i] === 1) assignment += 2 ** i;

    const previous = seen.get(assignment);
    if (previous) {
      throw parseError(
        `The input combination ${inputBits.join('')} appears twice (first on line ${previous.line}).`,
        'Each input combination may be listed at most once.',
        line.span,
      );
    }
    seen.set(assignment, line.span);

    rows.push({ assignment, inputBits, outputs: outputCells, span: line.span });
  }

  if (rows.length === 0) {
    throw parseError(
      'The table has a header but no rows.',
      'Add one row per input combination, for example: 0 1 | 1',
    );
  }

  const dontCare: number[] = [];
  const space = 2 ** header.inputs.length;
  for (let assignment = 0; assignment < space; assignment++) {
    const row = rows.find((r) => r.assignment === assignment);
    if (!row || row.outputs.includes(null)) dontCare.push(assignment);
  }

  return { inputs: header.inputs, outputs: header.outputs, rows, dontCare };
}

interface Line {
  readonly text: string;
  readonly span: Span;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  let lineNumber = 1;
  for (const raw of source.split('\n')) {
    const withoutComment = raw.split('#')[0]!;
    lines.push({
      text: withoutComment,
      span: { start: offset, end: offset + withoutComment.length, line: lineNumber, column: 1 },
    });
    offset += raw.length + 1;
    lineNumber++;
  }
  return lines;
}

function splitSides(line: Line): { left: string; right: string } {
  const separator = line.text.includes('|') ? '|' : line.text.includes('->') ? '->' : null;
  if (separator === null) {
    throw parseError(
      'This line has no separator between the input and output columns.',
      'Separate them with "|" or "->", for example: 0 1 | 1',
      line.span,
    );
  }
  const index = line.text.indexOf(separator);
  return { left: line.text.slice(0, index), right: line.text.slice(index + separator.length) };
}

function parseHeader(line: Line): { inputs: string[]; outputs: string[] } {
  const { left, right } = splitSides(line);
  const inputs = splitNames(left, line.span, 'input');
  const outputs = splitNames(right, line.span, 'output');

  const duplicate = [...inputs, ...outputs].find((name, i, all) => all.indexOf(name) !== i);
  if (duplicate) {
    throw parseError(`"${duplicate}" is used as a column name twice.`, 'Column names must be unique.', line.span);
  }
  return { inputs, outputs };
}

function splitNames(text: string, span: Span, role: string): string[] {
  const names = text
    .split(/[\s,]+/)
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) {
    throw parseError(`The header declares no ${role} columns.`, 'The header looks like: a b | sum carry', span);
  }
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw parseError(
        `"${name}" is not a valid ${role} name.`,
        'Names start with a letter or underscore and contain letters, digits and underscores.',
        span,
      );
    }
  }
  return names;
}

function parseCells(text: string, span: Span, expected: number, role: string): Cell[] {
  const cells: Cell[] = [];
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',') continue;
    if (ch === '0') cells.push(0);
    else if (ch === '1') cells.push(1);
    else if (ch === '-' || ch === 'x' || ch === 'X') cells.push(null);
    else {
      throw parseError(
        `"${ch}" is not a valid ${role} cell.`,
        'Cells are 0, 1, or - for a don\'t-care output.',
        span,
      );
    }
  }
  if (cells.length !== expected) {
    throw parseError(
      `This row has ${cells.length} ${role} cell(s); the header declares ${expected}.`,
      'Every row needs one cell per declared column.',
      span,
    );
  }
  return cells;
}
