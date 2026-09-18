/**
 * Python subset AST → Classical IR.
 *
 * Three things in this file are where "a subset of Python" stops being a slogan and
 * becomes a decision the user can be held to.
 *
 * **Every value is either a bit vector or a compile-time integer.** Literals and loop
 * variables start as integers, and an integer stays one as long as every operation on it
 * has both operands known — so `n - i` inside an unrolled loop is an index, not an
 * eight-gate subtractor. The moment an integer meets a runtime value it is materialised
 * as constant bits of its natural width and costs whatever it costs. This is not an
 * optimization of the circuit; it is the difference between a loop index and a wire.
 *
 * **`if` becomes `mux`, per name, over the union of what the branches assigned.** There is
 * no control flow in the IR to lower to, so both branches are always evaluated and the
 * result is selected. Two consequences the user has to know about, and both are errors
 * rather than surprises: a name assigned in only one branch must already have a value
 * before the `if` (otherwise it has none when the branch is not taken), and a `return`
 * inside a branch is refused, because a function with two exits has no single circuit.
 * When the condition is known at compile time — `if i == 0:` in an unrolled loop — the
 * untaken branch is not built at all, which is the case that makes loop bodies affordable.
 *
 * **`assert` under a branch becomes an implication.** An assertion inside `if c:` is not
 * "this always holds"; it is "this holds when `c`". Threading a path condition and
 * emitting `not(guard) or test` is what makes the assertion mean the same thing in the
 * circuit as it does in the source. Asserting the bare test would fail the verification on
 * inputs that never reach the line.
 *
 * As in the Boolean frontend, nothing here is common-subexpression-eliminated. The
 * zero-extensions that width matching inserts are real nodes that the constant-folding
 * pass removes, behind the equivalence guard, with before/after figures the user can read.
 *
 * ## Where a compiled function disagrees with CPython
 *
 * Every accepted program was run against CPython over its whole input space while this was
 * written, and it agrees everywhere except in five places. All five come from the same
 * root — Python's `int` is unbounded and a wire is not — and each is documented rather
 * than papered over, because a silent disagreement is exactly what this product exists to
 * prevent. The compiled circuit is authoritative; CPython is not a reference implementation
 * of the subset.
 *
 *   1. **Subtraction wraps.** `x - y` for `x < y` is `-1` in Python and `2^w - 1` here.
 *      There are no negative values, and unary minus is refused so that none can be written.
 *   2. **A declared width truncates.** `s: uint3 = x + y` drops the carry, which is what
 *      declaring the width is for. Python would keep growing the integer.
 *   3. **`~` inverts within the declared width.** `~x` on a `uint3` is `7 - x`; Python's is
 *      negative. A literal has no declared width, so `~1` is refused outright.
 *   4. **`and` / `or` produce a bit.** Python returns one of its *operands*, so `a and b`
 *      on two `uint2` values has a width that depends on which side won. That has no
 *      circuit, so both sides are reduced to truthiness. For single bits the two agree.
 *   5. **Indexing and slicing work on integers.** `x[2]` is bit 2 and `x[1:3]` is a
 *      two-bit field; in Python an `int` is not subscriptable at all. This is an addition,
 *      not a disagreement — nothing that means something else in Python changes meaning.
 */
import { ModuleBuilder, type ClassicalModule } from '../../ir/classical.js';
import { invalidSpec, parseError, unsupported, type Span } from '../../errors.js';
import type { TraceRecorder } from '../../trace/trace.js';
import {
  add,
  bitwise,
  constantBits,
  equals,
  invert,
  lessThan,
  reduceOr,
  select,
  shiftLeft,
  shiftRight,
  subtract,
  truncate,
  zeroExtend,
  type Bits,
} from './values.js';
import {
  parsePython,
  type PyExpr,
  type PyFunction,
  type PyStmt,
  type PyType,
} from './parser.js';

/**
 * How many times a `for` may be unrolled. The binding limit in practice is the module's
 * input and gate budget, which the pre-flight check enforces with real numbers; this one
 * exists so that `for i in range(100000)` fails in a millisecond with a sentence about
 * the loop instead of after allocating for a minute.
 */
export const MAX_UNROLL = 256;

export interface LowerPythonOptions {
  readonly moduleName?: string;
  readonly trace?: TraceRecorder;
}

/** A bit vector, or an integer the compiler knows the value of. */
type Value =
  | { readonly kind: 'bits'; readonly bits: Bits }
  | { readonly kind: 'int'; readonly value: number };

type Scope = Map<string, Value>;

const bitsValue = (bits: Bits): Value => ({ kind: 'bits', bits });
const intValue = (value: number): Value => ({ kind: 'int', value });

/** Bits needed to write `value` unsigned; 0 still needs one wire. */
const bitLength = (value: number): number => (value === 0 ? 1 : 32 - Math.clz32(value));

export function lowerPython(source: string, options: LowerPythonOptions = {}): ClassicalModule {
  return lowerFunction(parsePython(source), options);
}

export function lowerFunction(fn: PyFunction, options: LowerPythonOptions = {}): ClassicalModule {
  const builder = new ModuleBuilder(options.moduleName ?? fn.name);
  const trace = options.trace;

  let scope: Scope = new Map();
  /**
   * The condition under which the statements being lowered right now execute, or null at
   * the top level. Only `assert` reads it — assignments do not need it because a branch's
   * effect on a name is applied by the `mux` at the merge, not by the assignment itself.
   */
  let guard: number | null = null;
  const assertionNames = new Set<string>();

  // -----------------------------------------------------------------------
  // Parameters
  // -----------------------------------------------------------------------

  for (const param of fn.params) {
    if (scope.has(param.name)) {
      throw parseError(
        `Parameter "${param.name}" is declared twice.`,
        'Each parameter needs its own name.',
        param.span,
      );
    }
    const width = widthOfType(param.type);
    const bits: number[] = [];
    for (let i = 0; i < width; i++) {
      bits.push(builder.input(width === 1 ? param.name : `${param.name}[${i}]`, param.span));
    }
    scope.set(param.name, bitsValue({ bits }));
    trace?.add({
      phase: 'parse',
      kind: 'input.declared',
      message:
        width === 1
          ? `"${param.name}" is an input bit.`
          : `"${param.name}" is a ${width}-bit unsigned input, costing input bits ${param.name}[0] through ${param.name}[${width - 1}], least significant first.`,
      span: param.span,
      detail: { name: param.name, width },
    });
  }

  // -----------------------------------------------------------------------
  // Expressions
  // -----------------------------------------------------------------------

  /** Materialise a compile-time integer as constant wires of its natural width. */
  const toBits = (value: Value, span: Span): Bits => {
    if (value.kind === 'bits') return value.bits;
    return constantBits(builder, value.value, bitLength(value.value), span);
  };

  /**
   * Truthiness as a single bit. Python's `if x:` on an integer means `x != 0`, so a
   * multi-bit value reduces with OR rather than silently using its low bit.
   */
  const toBit = (value: Value, span: Span, label?: string): number => {
    const bits = toBits(value, span);
    if (bits.bits.length === 1) return bits.bits[0]!;
    trace?.add({
      phase: 'parse',
      kind: 'coerce.truth',
      message: `A ${bits.bits.length}-bit value is used as a condition, so it is tested for being non-zero, as Python does.`,
      span,
    });
    return reduceOr(builder, bits, span, label);
  };

  const constantInt = (expr: PyExpr, what: string): number => {
    const value = evaluate(expr);
    if (value.kind !== 'int') {
      throw invalidSpec(
        `${what} has to be known when the circuit is built, but this one depends on an input.`,
        'A shift, an index and a range bound all fix how the wires are connected, so they cannot ' +
          'vary per input. Use a literal or a loop variable.',
        {},
        expr.span,
      );
    }
    return value.value;
  };

  function evaluate(expr: PyExpr, label?: string): Value {
    switch (expr.kind) {
      case 'num':
        return intValue(expr.value);

      case 'bool':
        return bitsValue({ bits: [builder.constant(expr.value, expr.span)] });

      case 'name': {
        const found = scope.get(expr.name);
        if (found === undefined) {
          throw parseError(
            `"${expr.name}" is not defined.`,
            suggest(expr.name, [...scope.keys()]) ??
              'Assign it before this line, or add it as a parameter.',
            expr.span,
          );
        }
        return found;
      }

      case 'not': {
        const operand = evaluate(expr.operand);
        if (operand.kind === 'int') return intValue(operand.value === 0 ? 1 : 0);
        return bitsValue({ bits: [builder.op('not', [toBit(operand, expr.span)], expr.span, label)] });
      }

      case 'invert': {
        const operand = evaluate(expr.operand);
        if (operand.kind === 'int') {
          // `~5` is -6 in Python: the width is whatever the surrounding type says, and a
          // bare literal has no surrounding type. Inventing one would give a different
          // answer than Python for the same text.
          throw invalidSpec(
            '"~" applied to an integer literal has no width to invert within.',
            'In Python ~5 is -6, because int is unbounded and there are no negative values here. ' +
              'Invert a value whose width is declared, or mask instead: x ^ 0b1111.',
            {},
            expr.span,
          );
        }
        return bitsValue(invert(builder, operand.bits, expr.span, label));
      }

      case 'logical': {
        const left = evaluate(expr.left);
        const right = evaluate(expr.right);
        if (left.kind === 'int' && right.kind === 'int') {
          const value = expr.op === 'and' ? (left.value !== 0 && right.value !== 0) : (left.value !== 0 || right.value !== 0);
          return intValue(value ? 1 : 0);
        }
        // Python's `and` returns one of its *operands*, not a bool. For two bits that is
        // the same thing as `&`; for wider values it is not, and a value whose width
        // depends on which side won has no circuit. So this produces a bit, and says so.
        const a = toBit(left, expr.left.span);
        const b = toBit(right, expr.right.span);
        return bitsValue({ bits: [builder.op(expr.op, [a, b], expr.span, label)] });
      }

      case 'compare':
        return compare(expr, label);

      case 'binary':
        return binary(expr, label);

      case 'ternary': {
        const test = evaluate(expr.test);
        if (test.kind === 'int') {
          trace?.add({
            phase: 'parse',
            kind: 'branch.constant',
            message: `The condition of this conditional expression is ${test.value !== 0 ? 'always true' : 'always false'} when the circuit is built, so only one side is built.`,
            span: expr.span,
          });
          return evaluate(test.value !== 0 ? expr.ifTrue : expr.ifFalse, label);
        }
        const selector = toBit(test, expr.test.span);
        const ifTrue = toBits(evaluate(expr.ifTrue), expr.ifTrue.span);
        const ifFalse = toBits(evaluate(expr.ifFalse), expr.ifFalse.span);
        return bitsValue(select(builder, selector, ifTrue, ifFalse, expr.span, label));
      }

      case 'index': {
        const value = evaluate(expr.value);
        const index = constantInt(expr.index, 'An index');
        const bits = toBits(value, expr.span);
        if (index < 0 || index >= bits.bits.length) {
          throw invalidSpec(
            `Bit ${index} does not exist; this value is ${bits.bits.length} bit(s) wide.`,
            `Indices run from 0 (least significant) to ${bits.bits.length - 1}.`,
            { index, width: bits.bits.length },
            expr.span,
          );
        }
        return bitsValue({ bits: [bits.bits[index]!] });
      }

      case 'slice': {
        const value = evaluate(expr.value);
        const bits = toBits(value, expr.span);
        const lower = expr.lower === null ? 0 : constantInt(expr.lower, 'The start of a slice');
        const upper = expr.upper === null ? bits.bits.length : constantInt(expr.upper, 'The end of a slice');
        if (lower < 0 || upper > bits.bits.length || lower >= upper) {
          throw invalidSpec(
            `The slice [${lower}:${upper}] does not select any bits of a ${bits.bits.length}-bit value.`,
            `The start must be below the end, and both within 0 to ${bits.bits.length}.`,
            { lower, upper, width: bits.bits.length },
            expr.span,
          );
        }
        return bitsValue({ bits: bits.bits.slice(lower, upper) });
      }
    }
  }

  function compare(expr: PyExpr & { kind: 'compare' }, label?: string): Value {
    const left = evaluate(expr.left);
    const right = evaluate(expr.right);
    if (left.kind === 'int' && right.kind === 'int') {
      const a = left.value;
      const b = right.value;
      const result =
        expr.op === '==' ? a === b
        : expr.op === '!=' ? a !== b
        : expr.op === '<' ? a < b
        : expr.op === '<=' ? a <= b
        : expr.op === '>' ? a > b
        : a >= b;
      return intValue(result ? 1 : 0);
    }

    const a = toBits(left, expr.left.span);
    const b = toBits(right, expr.right.span);
    const span = expr.span;
    // Only two comparators are built: equality, and unsigned less-than. The other four
    // are those two with the operands swapped or the answer negated, which costs one NOT
    // rather than a second construction that could disagree with the first.
    const negate = (node: number) => builder.op('not', [node], span, label);
    switch (expr.op) {
      case '==':
        return bitsValue({ bits: [equals(builder, a, b, span, label)] });
      case '!=':
        return bitsValue({ bits: [negate(equals(builder, a, b, span, label))] });
      case '<':
        return bitsValue({ bits: [lessThan(builder, a, b, span, label)] });
      case '>=':
        return bitsValue({ bits: [negate(lessThan(builder, a, b, span, label))] });
      case '>':
        return bitsValue({ bits: [lessThan(builder, b, a, span, label)] });
      case '<=':
        return bitsValue({ bits: [negate(lessThan(builder, b, a, span, label))] });
    }
  }

  function binary(expr: PyExpr & { kind: 'binary' }, label?: string): Value {
    const span = expr.span;

    if (expr.op === '<<' || expr.op === '>>') {
      const value = evaluate(expr.left);
      const amount = constantInt(expr.right, 'A shift amount');
      if (amount < 0 || amount > 64) {
        throw invalidSpec(
          `A shift by ${amount} is out of range.`,
          'Shift by 0 to 64. A shift is rewiring, so the amount has to be a fixed number of positions.',
          { amount },
          span,
        );
      }
      if (value.kind === 'int') {
        return intValue(expr.op === '<<' ? value.value * 2 ** amount : Math.floor(value.value / 2 ** amount));
      }
      return bitsValue(
        expr.op === '<<'
          ? shiftLeft(builder, value.bits, amount, span)
          : shiftRight(builder, value.bits, amount, span),
      );
    }

    const left = evaluate(expr.left);
    const right = evaluate(expr.right);

    if (left.kind === 'int' && right.kind === 'int') {
      switch (expr.op) {
        case '+':
          return intValue(left.value + right.value);
        case '-': {
          const value = left.value - right.value;
          if (value < 0) {
            throw invalidSpec(
              `${left.value} - ${right.value} is negative, and there are no negative values here.`,
              'Both sides are known when the circuit is built, so this is a counting mistake rather than ' +
                'a wrapping subtraction. Values wrap only when they are bit vectors of a declared width.',
              {},
              span,
            );
          }
          return intValue(value);
        }
        case '&':
          return intValue(left.value & right.value);
        case '|':
          return intValue(left.value | right.value);
        case '^':
          return intValue(left.value ^ right.value);
      }
    }

    const a = toBits(left, expr.left.span);
    const b = toBits(right, expr.right.span);
    switch (expr.op) {
      case '+':
        return bitsValue(add(builder, a, b, span, label));
      case '-':
        return bitsValue(subtract(builder, a, b, span, label));
      case '&':
        return bitsValue(bitwise(builder, 'and', a, b, span, label));
      case '|':
        return bitsValue(bitwise(builder, 'or', a, b, span, label));
      case '^':
        return bitsValue(bitwise(builder, 'xor', a, b, span, label));
    }
  }

  // -----------------------------------------------------------------------
  // Annotations
  // -----------------------------------------------------------------------

  /**
   * Apply a declared width. Widening is free; narrowing to a `uintN` wraps, which is what
   * declaring a width is *for* — `s: uint4 = a + b` is how a user says they want the carry
   * dropped. Narrowing to `bit` is refused, because it is far more often a mistake than a
   * request for the low bit, and both readings have a short spelling that says which.
   */
  const applyType = (value: Value, type: PyType, name: string, span: Span): Value => {
    const width = widthOfType(type);
    const bits = toBits(value, span);
    if (bits.bits.length === width) return bitsValue(bits);
    if (bits.bits.length < width) return bitsValue(zeroExtend(builder, bits, width, span));
    if (type.kind === 'bit') {
      throw invalidSpec(
        `"${name}" is declared as a bit, but the value assigned to it is ${bits.bits.length} bits wide.`,
        `Write "${name} = x != 0" to test whether it is non-zero, or "${name} = x[0]" for its low bit — ` +
          'silently keeping one of the two would make the line mean something it does not say.',
        { name, declared: 1, actual: bits.bits.length },
        span,
      );
    }
    trace?.add({
      phase: 'parse',
      kind: 'coerce.truncate',
      message: `"${name}" is declared ${width} bits wide, so the value's top ${bits.bits.length - width} bit(s) are dropped — it wraps, as a fixed-width register does.`,
      span,
      detail: { name, declared: width, actual: bits.bits.length },
    });
    return bitsValue(truncate(bits, width));
  };

  // -----------------------------------------------------------------------
  // Statements
  // -----------------------------------------------------------------------

  const assign = (name: string, value: Value) => {
    scope.set(name, value);
  };

  function execute(statements: readonly PyStmt[]): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'pass':
          break;

        case 'return':
          // Reachable only from a branch or a loop body; the top level pulls its return
          // off the end of the body before calling this.
          throw unsupported(
            'A return anywhere but the last line of the function',
            [
              'one return, as the last statement',
              'assigning to a name in every branch and returning it at the end',
            ],
            statement.span,
          );

        case 'assign': {
          if (statement.annotation !== null && statement.targets.length > 1) {
            throw parseError(
              'A type annotation applies to a single name.',
              'Write the annotated assignment on its own line.',
              statement.span,
            );
          }
          if (statement.targets.length !== statement.values.length) {
            throw parseError(
              `${statement.targets.length} name(s) on the left, ${statement.values.length} value(s) on the right.`,
              statement.values.length === 1
                ? 'There are no calls or tuples in the subset, so each name needs its own value: "s, c = a ^ b, a & b".'
                : 'Give each name exactly one value.',
              statement.span,
            );
          }
          // Evaluated before anything is bound, so `a, b = b, a` swaps rather than
          // assigning `a` to both.
          const values = statement.values.map((value, i) => evaluate(value, statement.targets[i]!.name));
          statement.targets.forEach((target, i) => {
            const value = statement.annotation
              ? applyType(values[i]!, statement.annotation, target.name, target.span)
              : values[i]!;
            assign(target.name, value);
          });
          break;
        }

        case 'aug': {
          const current = scope.get(statement.target.name);
          if (current === undefined) {
            throw parseError(
              `"${statement.target.name}" has no value yet, so it cannot be updated in place.`,
              `Assign it first: "${statement.target.name} = ..."`,
              statement.span,
            );
          }
          const value = binary(
            { kind: 'binary', op: statement.op, left: { kind: 'name', name: statement.target.name, span: statement.target.span }, right: statement.value, span: statement.span },
            statement.target.name,
          );
          assign(statement.target.name, value);
          break;
        }

        case 'assert': {
          const test = evaluate(statement.test);
          if (test.kind === 'int') {
            if (test.value === 0) {
              throw invalidSpec(
                'This assertion is false when the circuit is built, so no circuit can satisfy it.',
                'Both sides are known here; check the constants and the loop bounds.',
                {},
                statement.span,
              );
            }
            trace?.add({
              phase: 'parse',
              kind: 'assertion.constant',
              message: 'This assertion is true when the circuit is built, so it costs no gates and is not checked at run time.',
              span: statement.span,
            });
            break;
          }
          const bit = toBit(test, statement.span);
          // Under a branch the assertion is an implication: it claims the test holds
          // *where the branch is taken*, and holding the circuit to it elsewhere would
          // fail on inputs that never reach this line.
          const node =
            guard === null
              ? bit
              : builder.op('or', [builder.op('not', [guard], statement.span), bit], statement.span);
          const name = uniqueAssertionName(assertionNames, statement.span.line);
          builder.assertion(name, node, statement.span);
          trace?.add({
            phase: 'parse',
            kind: guard === null ? 'assertion.bind' : 'assertion.guarded',
            message:
              guard === null
                ? `Invariant "${name}" must hold for every input assignment; it is checked, not synthesised into an output.`
                : `Invariant "${name}" is inside a branch, so it is checked as an implication: it must hold wherever that branch is taken, and is not required elsewhere.`,
            nodeId: node,
            span: statement.span,
          });
          break;
        }

        case 'if':
          lowerIf(statement);
          break;

        case 'for':
          lowerFor(statement);
          break;
      }
    }
  }

  function lowerIf(statement: PyStmt & { kind: 'if' }): void {
    const test = evaluate(statement.test);

    if (test.kind === 'int') {
      trace?.add({
        phase: 'parse',
        kind: 'branch.constant',
        message: `This condition is ${test.value !== 0 ? 'always true' : 'always false'} when the circuit is built, so only the ${test.value !== 0 ? '"if"' : '"else"'} side is built.`,
        span: statement.span,
      });
      execute(test.value !== 0 ? statement.body : statement.orelse);
      return;
    }

    const selector = toBit(test, statement.test.span);
    const notSelector = builder.op('not', [selector], statement.test.span);
    const before = scope;
    const outerGuard = guard;

    const branch = (body: readonly PyStmt[], condition: number): Scope => {
      scope = new Map(before);
      guard = outerGuard === null ? condition : builder.op('and', [outerGuard, condition], statement.span);
      execute(body);
      const result = scope;
      scope = before;
      guard = outerGuard;
      return result;
    };

    const taken = branch(statement.body, selector);
    const untaken = branch(statement.orelse, notSelector);

    const merged: Scope = new Map(before);
    let muxed = 0;
    for (const name of new Set([...taken.keys(), ...untaken.keys()])) {
      const ifOne = taken.get(name);
      const ifZero = untaken.get(name);
      const prior = before.get(name);

      // A name assigned in only one branch keeps whatever it held before the `if`. With
      // nothing before the `if` it has no value at all on the other path, and a mux
      // against an invented zero would be a value the source never wrote.
      const one = ifOne ?? prior;
      const zero = ifZero ?? prior;
      if (one === undefined || zero === undefined) {
        throw invalidSpec(
          `"${name}" is assigned in only one branch of this "if", and has no value before it.`,
          `Both branches produce a value here, because the circuit evaluates both. Give "${name}" a ` +
            'value before the "if", or assign it in the other branch as well.',
          { name },
          statement.span,
        );
      }
      if (sameValue(one, zero)) {
        merged.set(name, one);
        continue;
      }
      merged.set(
        name,
        bitsValue(select(builder, selector, toBits(one, statement.span), toBits(zero, statement.span), statement.span, name)),
      );
      muxed++;
    }
    scope = merged;

    trace?.add({
      phase: 'parse',
      kind: 'branch.merge',
      message:
        muxed === 0
          ? 'Both sides of this "if" leave every name unchanged, so no selection gates are needed.'
          : `Both sides of this "if" are evaluated and ${muxed === 1 ? 'the one name it changes is' : `the ${muxed} names it changes are`} selected by the condition — the IR has no branches, so a choice is a multiplexer.`,
      span: statement.span,
      detail: { muxed },
    });
  }

  function lowerFor(statement: PyStmt & { kind: 'for' }): void {
    const bounds = statement.args.map((arg) => constantInt(arg, 'A range bound'));
    const start = bounds.length === 1 ? 0 : bounds[0]!;
    const stop = bounds.length === 1 ? bounds[0]! : bounds[1]!;
    const step = bounds.length === 3 ? bounds[2]! : 1;

    if (step < 1) {
      throw invalidSpec(
        `range() needs a step of at least 1 here; this one is ${step}.`,
        'Counting down is written the other way round, because the subset has no unary minus: ' +
          'loop upward and index with "n - i".',
        { step },
        statement.span,
      );
    }
    const iterations = start >= stop ? 0 : Math.ceil((stop - start) / step);
    if (iterations > MAX_UNROLL) {
      throw invalidSpec(
        `This loop runs ${iterations} times; the limit is ${MAX_UNROLL}.`,
        'Loops are unrolled, because a reversible circuit has no branches to jump back to, so the ' +
          'body is emitted once per iteration. Reduce the count or the width.',
        { iterations, limit: MAX_UNROLL },
        statement.span,
      );
    }

    trace?.add({
      phase: 'parse',
      kind: 'loop.unroll',
      message:
        iterations === 0
          ? `This loop runs zero times, so its body is not built.`
          : `This loop is unrolled into ${iterations} copies of its body, with "${statement.name}" fixed in each; a circuit has nothing to jump back to.`,
      span: statement.span,
      detail: { name: statement.name, start, stop, step, iterations },
    });

    const shadowed = scope.get(statement.name);
    for (let i = start; i < stop; i += step) {
      scope.set(statement.name, intValue(i));
      execute(statement.body);
    }
    // Python leaks the loop variable; restoring the shadowed value instead keeps a name
    // from silently changing type from a bit vector to an integer across the loop.
    if (shadowed === undefined) scope.delete(statement.name);
    else scope.set(statement.name, shadowed);
  }

  // -----------------------------------------------------------------------
  // The body, and the outputs
  // -----------------------------------------------------------------------

  const last = fn.body[fn.body.length - 1];
  if (last === undefined || last.kind !== 'return') {
    throw parseError(
      'The function does not end with a return.',
      'The last statement has to be the return, because a circuit has one set of outputs and no way ' +
        'to leave early. Assign to names in the branches and return them at the end.',
      last?.span ?? fn.span,
    );
  }
  execute(fn.body.slice(0, -1));

  if (last.values.length !== fn.returns.length) {
    throw parseError(
      `The annotation declares ${fn.returns.length} return value(s), but ${last.values.length} ${last.values.length === 1 ? 'is' : 'are'} returned.`,
      'The annotation fixes the width of each output, so there has to be one for each returned value.',
      last.span,
    );
  }

  last.values.forEach((expr, i) => {
    const declared = fn.returns[i]!;
    const name = outputName(expr, i, last.values.length);
    const value = applyType(evaluate(expr, name), declared, name, expr.span);
    const bits = toBits(value, expr.span);
    bits.bits.forEach((node, bit) => {
      builder.output(bits.bits.length === 1 ? name : `${name}[${bit}]`, node, expr.span);
    });
    trace?.add({
      phase: 'parse',
      kind: 'output.bind',
      message:
        bits.bits.length === 1
          ? `"${name}" is an output bit of the module.`
          : `"${name}" is a ${bits.bits.length}-bit output, exported as ${name}[0] through ${name}[${bits.bits.length - 1}], least significant first.`,
      span: expr.span,
      detail: { name, width: bits.bits.length },
    });
  });

  return builder.build();
}

function widthOfType(type: PyType): number {
  return type.kind === 'bit' ? 1 : type.width;
}

/**
 * Outputs take their names from the source where the source has one. `return s, cout`
 * names them `s` and `cout`; `return a ^ b` has no name to take, so it falls back to a
 * positional one rather than inventing something from the expression.
 */
function outputName(expr: PyExpr, index: number, total: number): string {
  if (expr.kind === 'name') return expr.name;
  return total === 1 ? 'out' : `out${index}`;
}

function uniqueAssertionName(used: Set<string>, line: number): string {
  const base = `assert_line_${line}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

/** Whether two values are already the same wires — a merge that would be the identity. */
function sameValue(a: Value, b: Value): boolean {
  if (a.kind === 'int' && b.kind === 'int') return a.value === b.value;
  if (a.kind !== 'bits' || b.kind !== 'bits') return false;
  return a.bits.bits.length === b.bits.bits.length && a.bits.bits.every((node, i) => node === b.bits.bits[i]);
}

/** Nearest name in scope by edit distance — a typo is the usual cause of "not defined". */
function suggest(name: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    const allowed = candidate.length <= 4 ? 1 : 2;
    if (distance <= allowed && (!best || distance < best.distance)) best = { name: candidate, distance };
  }
  return best ? `Did you mean "${best.name}"?` : undefined;
}

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
