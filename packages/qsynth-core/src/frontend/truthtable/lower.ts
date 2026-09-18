/**
 * Truth table → Classical IR, by Shannon decomposition with memoisation.
 *
 * The obvious synthesis — sum of products over the minterms — is the wrong choice here.
 * A 12-input table has 4096 rows; half of them being 1s would produce ~2000 AND terms of
 * 12 literals each, roughly 25k nodes, and the Bennett lowering turns each node into an
 * ancilla and a Toffoli. Exhaustive verification of that is ~200M gate applications.
 *
 * Shannon decomposition instead splits on one variable at a time, `f = MUX(x, f|x=1,
 * f|x=0)`, and memoises subfunctions by their bit pattern. Identical subfunctions — the
 * common case in structured tables like adders and comparators — collapse to one node,
 * and the result is an ROBDD in MUX form: at most 2^n nodes, usually far fewer, shared
 * across all outputs. A full adder comes out in single-digit nodes.
 *
 * Don't-care cells participate: a subfunction with no 1s becomes the constant 0 even if
 * it contains `-`. That is sound because verification skips don't-care assignments
 * entirely — but it does mean the circuit produces *some* value there, so the trace says
 * which assignments were left to the compiler.
 */
import { ModuleBuilder, type ClassicalModule } from '../../ir/classical.js';
import { assertInvariant } from '../../errors.js';
import type { TraceRecorder } from '../../trace/trace.js';
import { parseTruthTable, type TruthTable } from './parser.js';

export interface LowerTableOptions {
  readonly moduleName?: string;
  readonly trace?: TraceRecorder;
}

export function lowerTruthTable(source: string, options: LowerTableOptions = {}): ClassicalModule {
  return lowerTable(parseTruthTable(source), options);
}

export function lowerTable(table: TruthTable, options: LowerTableOptions = {}): ClassicalModule {
  const builder = new ModuleBuilder(options.moduleName ?? 'module');
  const trace = options.trace;
  const inputCount = table.inputs.length;
  const space = 2 ** inputCount;

  const inputNodes = table.inputs.map((name) => builder.input(name));
  trace?.add({
    phase: 'parse',
    kind: 'table.read',
    message:
      `The table declares ${inputCount} input(s) and ${table.outputs.length} output(s), ` +
      `and specifies ${table.rows.length} of ${space} possible input combination(s).`,
    detail: { inputs: table.inputs, outputs: table.outputs, rows: table.rows.length, space },
  });

  if (table.dontCare.length > 0) {
    trace?.add({
      phase: 'parse',
      kind: 'table.dontcare',
      message:
        `${table.dontCare.length} input combination(s) are unconstrained — either omitted from the table or ` +
        'marked "-". The compiler is free to produce any value there, and equivalence is not checked on them.',
      detail: { assignments: table.dontCare.slice(0, 64), total: table.dontCare.length },
    });
    builder.markDontCare(table.dontCare);
  }

  // Column-major view: for each output, its value at each assignment.
  const byAssignment = new Map(table.rows.map((row) => [row.assignment, row.outputs]));
  const memo = new Map<string, number>();
  let nodesCreated = 0;
  let memoHits = 0;

  const build = (level: number, pattern: string): number => {
    const key = `${level}:${pattern}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      memoHits++;
      return cached;
    }

    let id: number;
    if (!pattern.includes('1')) {
      id = builder.constant(0);
      nodesCreated++;
    } else if (!pattern.includes('0')) {
      id = builder.constant(1);
      nodesCreated++;
    } else {
      assertInvariant(level > 0, 'a single-cell pattern must be constant');
      const half = pattern.length >> 1;
      const low = pattern.slice(0, half);
      const high = pattern.slice(half);
      if (low === high) {
        // The variable does not affect the result; skip it rather than emitting a MUX.
        id = build(level - 1, low);
      } else {
        const selector = inputNodes[level - 1]!;
        id = builder.op('mux', [selector, build(level - 1, high), build(level - 1, low)]);
        nodesCreated++;
      }
    }

    memo.set(key, id);
    return id;
  };

  table.outputs.forEach((name, index) => {
    let pattern = '';
    for (let assignment = 0; assignment < space; assignment++) {
      const cell = byAssignment.get(assignment)?.[index];
      pattern += cell === 1 ? '1' : cell === 0 ? '0' : '-';
    }
    const node = build(inputCount, pattern);
    builder.output(name, node);
    trace?.add({
      phase: 'parse',
      kind: 'table.output',
      message: `Output "${name}" is synthesised from its column by Shannon decomposition on the input bits.`,
      nodeId: node,
      detail: { output: name },
    });
  });

  trace?.add({
    phase: 'parse',
    kind: 'table.synthesis',
    message:
      `Synthesis produced ${nodesCreated} node(s); ${memoHits} subfunction(s) were shared rather than rebuilt. ` +
      'Sharing is why a structured table does not grow one term per row.',
    detail: { nodesCreated, memoHits },
  });

  return builder.build();
}
