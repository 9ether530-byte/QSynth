/**
 * Boolean AST → Classical IR.
 *
 * Inputs may be declared explicitly (`in a, b, c`) or left implicit, in which case a name
 * that is never assigned becomes an input at its first use, in source order. Implicit
 * inputs make the one-line case (`out = a AND b`) work without ceremony; the trade is
 * that a typo becomes an input rather than an error, so the moment the spec declares
 * *any* input explicitly, every name must be accounted for and an unknown one is a parse
 * error naming the closest declared name.
 *
 * No common-subexpression elimination happens here. `(a AND b) XOR (a AND b)` produces
 * two AND nodes, and it is the optimizer's job — with its before/after accounting and its
 * equivalence guard — to collapse them. A frontend that quietly optimized would make the
 * optimizer's reported savings a fiction.
 */
import { ModuleBuilder, type ClassicalModule } from '../../ir/classical.js';
import { parseError, type Span } from '../../errors.js';
import type { TraceRecorder } from '../../trace/trace.js';
import { parseBoolean, type Expr, type Statement } from './parser.js';

export interface LowerBooleanOptions {
  readonly moduleName?: string;
  readonly trace?: TraceRecorder;
}

export function lowerBoolean(source: string, options: LowerBooleanOptions = {}): ClassicalModule {
  const program = parseBoolean(source);
  return lowerProgram(program.statements, options);
}

function lowerProgram(statements: readonly Statement[], options: LowerBooleanOptions): ClassicalModule {
  const builder = new ModuleBuilder(options.moduleName ?? 'module');
  const trace = options.trace;
  const scope = new Map<string, number>();
  const inputs = new Set<string>();
  const explicitInputs = statements.some((s) => s.kind === 'inputs');

  const resolve = (name: string, span: Span): number => {
    const existing = scope.get(name);
    if (existing !== undefined) return existing;
    if (explicitInputs) {
      throw parseError(
        `"${name}" is not defined.`,
        suggest(name, [...scope.keys()]) ??
          'Declare it as an input with an "in" line, or define it with "let" before using it.',
        span,
      );
    }
    const id = builder.input(name, span);
    scope.set(name, id);
    inputs.add(name);
    trace?.add({
      phase: 'parse',
      kind: 'input.implicit',
      message: `"${name}" is never assigned, so it is treated as an input bit.`,
      nodeId: id,
      span,
    });
    return id;
  };

  const build = (expr: Expr, label?: string): number => {
    switch (expr.kind) {
      case 'ref':
        return resolve(expr.name, expr.span);
      case 'const':
        return builder.constant(expr.value, expr.span);
      case 'not':
        return builder.op('not', [build(expr.operand)], expr.span, label);
      case 'binary': {
        const left = build(expr.left);
        const right = build(expr.right);
        return builder.op(expr.op.toLowerCase() as 'and', [left, right], expr.span, label);
      }
      case 'mux': {
        const selector = build(expr.selector);
        const ifOne = build(expr.ifOne);
        const ifZero = build(expr.ifZero);
        return builder.op('mux', [selector, ifOne, ifZero], expr.span, label);
      }
    }
  };

  const claim = (name: string, span: Span, what: string) => {
    if (scope.has(name)) {
      throw parseError(
        `"${name}" is already defined.`,
        inputs.has(name) ? 'Input names cannot be reassigned.' : `Choose a different name for this ${what}.`,
        span,
      );
    }
  };

  for (const statement of statements) {
    switch (statement.kind) {
      case 'inputs':
        for (const { name, span } of statement.names) {
          claim(name, span, 'input');
          const id = builder.input(name, span);
          scope.set(name, id);
          inputs.add(name);
          trace?.add({
            phase: 'parse',
            kind: 'input.declared',
            message: `"${name}" is declared as an input bit.`,
            nodeId: id,
            span,
          });
        }
        break;

      case 'let': {
        claim(statement.name, statement.span, 'value');
        const id = build(statement.expr, statement.name);
        scope.set(statement.name, id);
        trace?.add({
          phase: 'parse',
          kind: 'let.bind',
          message: `"${statement.name}" names an intermediate value; it is not exported as an output.`,
          nodeId: id,
          span: statement.span,
        });
        break;
      }

      case 'output': {
        claim(statement.name, statement.span, 'output');
        const id = build(statement.expr, statement.name);
        scope.set(statement.name, id);
        builder.output(statement.name, id, statement.span);
        trace?.add({
          phase: 'parse',
          kind: 'output.bind',
          message: `"${statement.name}" is an output of the module.`,
          nodeId: id,
          span: statement.span,
        });
        break;
      }

      case 'assert': {
        const id = build(statement.expr, statement.name);
        builder.assertion(statement.name, id, statement.span);
        trace?.add({
          phase: 'parse',
          kind: 'assertion.bind',
          message: `Invariant "${statement.name}" must hold for every input assignment; it is checked, not synthesised into an output.`,
          nodeId: id,
          span: statement.span,
        });
        break;
      }
    }
  }

  return builder.build();
}

/** Nearest declared name by edit distance — a typo is the usual cause of "not defined". */
function suggest(name: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    // One edit for short names, two for longer ones — long names absorb a slip without
    // becoming ambiguous, and two edits on a three-letter name is a different word.
    const allowed = candidate.length <= 4 ? 1 : 2;
    if (distance <= allowed && (!best || distance < best.distance)) best = { name: candidate, distance };
  }
  return best ? `Did you mean "${best.name}"?` : undefined;
}

/**
 * Damerau-Levenshtein: adjacent transposition costs 1, not 2. Typing "alhpa" for "alpha"
 * is the single most common typo there is, and plain Levenshtein scores it the same as
 * two unrelated substitutions — far enough away to suppress the suggestion.
 */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push(new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
}
