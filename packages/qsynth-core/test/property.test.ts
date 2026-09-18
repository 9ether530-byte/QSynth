/**
 * Property tests over randomly generated specifications.
 *
 * The unit suites check the cases we thought of. These check the ones we didn't, against
 * an expression evaluator written independently of the compiler (`evalExpr` below walks
 * the generated tree directly; it shares no code with the Classical IR or the simulator).
 *
 * The last property is the important one. Everything above it asks "is the compiler
 * right?"; the mutation property asks "would we *notice* if it weren't?" — it breaks a
 * verified circuit at a random gate and requires verification either to fail with a
 * counterexample that genuinely reproduces, or to pass only when the mutation provably
 * changed nothing. A verification gate that cannot be shown to fail is decoration.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  assignmentToBits,
  compile,
  estimate as estimateResources,
  initialState,
  lowerBoolean,
  lowerToReversible,
  outputsByName,
  run,
  TraceRecorder,
  verify,
  type Bit,
  type Gate,
  type ReversibleCircuit,
} from '@qsynth/core';

// --- generated expressions ---------------------------------------------------------

type Expr =
  | { readonly op: 'var'; readonly name: string }
  | { readonly op: 'const'; readonly value: 0 | 1 }
  | { readonly op: 'not'; readonly a: Expr }
  | { readonly op: 'bin'; readonly kind: BinKind; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'mux'; readonly s: Expr; readonly x: Expr; readonly y: Expr };

type BinKind = 'AND' | 'OR' | 'XOR' | 'NAND' | 'NOR' | 'XNOR';
const BIN_KINDS: readonly BinKind[] = ['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR'];

function evalExpr(expr: Expr, env: Record<string, Bit>): Bit {
  switch (expr.op) {
    case 'var':
      return env[expr.name]!;
    case 'const':
      return expr.value;
    case 'not':
      return (evalExpr(expr.a, env) ^ 1) as Bit;
    case 'mux':
      return evalExpr(expr.s, env) === 1 ? evalExpr(expr.x, env) : evalExpr(expr.y, env);
    case 'bin': {
      const a = evalExpr(expr.a, env);
      const b = evalExpr(expr.b, env);
      switch (expr.kind) {
        case 'AND':
          return (a & b) as Bit;
        case 'OR':
          return (a | b) as Bit;
        case 'XOR':
          return (a ^ b) as Bit;
        case 'NAND':
          return ((a & b) ^ 1) as Bit;
        case 'NOR':
          return ((a | b) ^ 1) as Bit;
        case 'XNOR':
          return ((a ^ b) ^ 1) as Bit;
      }
    }
  }
}

/** Fully parenthesised, so the rendering carries no assumption about precedence. */
function render(expr: Expr): string {
  switch (expr.op) {
    case 'var':
      return expr.name;
    case 'const':
      return String(expr.value);
    case 'not':
      return `(NOT ${render(expr.a)})`;
    case 'bin':
      return `(${render(expr.a)} ${expr.kind} ${render(expr.b)})`;
    case 'mux':
      return `MUX(${render(expr.s)}, ${render(expr.x)}, ${render(expr.y)})`;
  }
}

function exprArb(names: readonly string[]) {
  const { expr } = fc.letrec<{ expr: Expr }>((tie) => ({
    expr: fc.oneof(
      { maxDepth: 3, depthSize: 'small', withCrossShrink: true },
      fc.constantFrom(...names).map((name): Expr => ({ op: 'var', name })),
      fc.constantFrom<0 | 1>(0, 1).map((value): Expr => ({ op: 'const', value })),
      tie('expr').map((a): Expr => ({ op: 'not', a })),
      fc
        .tuple(fc.constantFrom(...BIN_KINDS), tie('expr'), tie('expr'))
        .map(([kind, a, b]): Expr => ({ op: 'bin', kind, a, b })),
      fc.tuple(tie('expr'), tie('expr'), tie('expr')).map(([s, x, y]): Expr => ({ op: 'mux', s, x, y })),
    ),
  }));
  return expr;
}

interface Spec {
  readonly names: readonly string[];
  readonly outputs: readonly { readonly name: string; readonly expr: Expr }[];
}

const specArb = fc
  .integer({ min: 1, max: 4 })
  .chain((inputCount) => {
    const names = Array.from({ length: inputCount }, (_, i) => `x${i}`);
    return fc.record({
      names: fc.constant(names),
      outputs: fc.array(exprArb(names), { minLength: 1, maxLength: 3 }).map((exprs) =>
        exprs.map((expr, i) => ({ name: `y${i}`, expr })),
      ),
    });
  })
  .map((spec): Spec => spec);

function sourceOf(spec: Spec): string {
  return [`in ${spec.names.join(', ')}`, ...spec.outputs.map((o) => `${o.name} = ${render(o.expr)}`)].join('\n');
}

/** Every assignment over the spec's inputs, as (bits, name→bit). */
function assignments(spec: Spec): { bits: Bit[]; env: Record<string, Bit> }[] {
  const all: { bits: Bit[]; env: Record<string, Bit> }[] = [];
  for (let a = 0; a < 2 ** spec.names.length; a++) {
    const bits = assignmentToBits(a, spec.names.length);
    const env: Record<string, Bit> = {};
    spec.names.forEach((name, i) => (env[name] = bits[i]!));
    all.push({ bits, env });
  }
  return all;
}

const RUNS = { numRuns: 120 };

// --- properties --------------------------------------------------------------------

describe('any specification the parser accepts', () => {
  it('compiles to a circuit that matches it on every input', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const result = compile({ kind: 'boolean', source: sourceOf(spec) });
        expect(result.report.passed).toBe(true);
        for (const { bits, env } of assignments(spec)) {
          const observed = outputsByName(result.circuit, run(result.circuit, initialState(result.circuit, bits)));
          for (const output of spec.outputs) {
            expect(observed[output.name], `${output.name} at ${JSON.stringify(env)}`).toBe(evalExpr(output.expr, env));
          }
        }
      }),
      RUNS,
    );
  });

  it('returns every ancilla to zero and leaves every input untouched', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const result = compile({ kind: 'boolean', source: sourceOf(spec) });
        for (const { bits } of assignments(spec)) {
          const state = run(result.circuit, initialState(result.circuit, bits));
          expect(result.circuit.ancillas.every((a) => state[a.wire] === 0)).toBe(true);
          expect(result.circuit.inputs.map((i) => state[i.wire])).toEqual([...bits]);
        }
      }),
      RUNS,
    );
  });

  it('verifies exhaustively, never by sampling, within the exhaustive limit', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const coverage = compile({ kind: 'boolean', source: sourceOf(spec) }).report.checks.find(
          (c) => c.id === 'simulation_equivalence',
        )!.coverage!;
        expect(coverage.mode).toBe('exhaustive');
        expect(coverage.checked).toBe(2 ** spec.names.length);
      }),
      RUNS,
    );
  });

  it('emits one QASM instruction per gate, and the same bytes every time', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const source = sourceOf(spec);
        const first = compile({ kind: 'boolean', source });
        const second = compile({ kind: 'boolean', source });
        expect(second.artifactHash).toBe(first.artifactHash);
        expect(second.qasm).toBe(first.qasm);
        const instructions = first.qasm.split('\n').filter((l) => /^(x|cx|ccx|cswap) /.test(l));
        expect(instructions).toHaveLength(first.circuit.gates.length);
      }),
      RUNS,
    );
  });

  it('costs a gate count linear in the operation count, both directions counted', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const result = compile({ kind: 'boolean', source: sourceOf(spec) });
        const operations = result.module.nodes.filter((n) => n.op !== 'input').length;
        // Compute + uncompute, at most three gates per operation each way, plus one
        // copy-out CNOT per output. This is the bound `projectGateCount` promises the
        // pre-flight check, so a lowering rule that outgrew it would be caught here.
        expect(result.circuit.gates.length).toBeLessThanOrEqual(operations * 6 + result.module.outputs.length);
      }),
      RUNS,
    );
  });
});

describe('the parser', () => {
  it('reads an expression written with precedence exactly as one written with brackets', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const bracketed = compile({ kind: 'boolean', source: sourceOf(spec) });
        const bare = compile({
          kind: 'boolean',
          source: [
            `in ${spec.names.join(', ')}`,
            ...spec.outputs.map((o) => `${o.name} = ${renderTight(o.expr, 0)}`),
          ].join('\n'),
        });
        for (const { bits } of assignments(spec)) {
          const a = outputsByName(bracketed.circuit, run(bracketed.circuit, initialState(bracketed.circuit, bits)));
          const b = outputsByName(bare.circuit, run(bare.circuit, initialState(bare.circuit, bits)));
          expect(b).toEqual(a);
        }
      }),
      RUNS,
    );
  });

  it('gives operators of equal precedence left associativity', () => {
    fc.assert(
      fc.property(fc.constantFrom(...BIN_KINDS), fc.constantFrom(...BIN_KINDS), (first, second) => {
        if (PRECEDENCE[first] !== PRECEDENCE[second]) return;
        const chained = compile({ kind: 'boolean', source: `in a, b, c\nout = a ${first} b ${second} c` });
        const explicit = compile({ kind: 'boolean', source: `in a, b, c\nout = (a ${first} b) ${second} c` });
        for (let a = 0; a < 8; a++) {
          const bits = assignmentToBits(a, 3);
          const left = outputsByName(chained.circuit, run(chained.circuit, initialState(chained.circuit, bits)));
          const right = outputsByName(explicit.circuit, run(explicit.circuit, initialState(explicit.circuit, bits)));
          expect(left).toEqual(right);
        }
      }),
      { numRuns: 36 },
    );
  });
});

/** Mirrors the precedence table in the parser; equal numbers associate left. */
const PRECEDENCE: Record<BinKind, number> = { OR: 0, NOR: 0, XOR: 1, XNOR: 1, AND: 2, NAND: 2 };

/**
 * The same expression written the way a person would: brackets only where precedence or
 * left-associativity would otherwise change the meaning. Compiling this and the fully
 * bracketed form must give the same truth table — that equality *is* the precedence test.
 */
function renderTight(expr: Expr, minimum: number): string {
  switch (expr.op) {
    case 'var':
      return expr.name;
    case 'const':
      return String(expr.value);
    case 'mux':
      return `MUX(${renderTight(expr.s, 0)}, ${renderTight(expr.x, 0)}, ${renderTight(expr.y, 0)})`;
    case 'not': {
      // NOT binds tighter than every binary operator, but not tighter than itself in a
      // position expecting an operand of a NOT — `NOT NOT a` is fine, so no brackets.
      const inner = renderTight(expr.a, 3);
      return `NOT ${inner}`;
    }
    case 'bin': {
      const precedence = PRECEDENCE[expr.kind];
      // Left-associative: the right operand must bind more tightly to stay unbracketed.
      const text = `${renderTight(expr.a, precedence)} ${expr.kind} ${renderTight(expr.b, precedence + 1)}`;
      return precedence >= minimum ? text : `(${text})`;
    }
  }
}

describe('verification, when the circuit is broken on purpose', () => {
  it('fails with a counterexample that reproduces, or passes only if the break was a no-op', () => {
    fc.assert(
      fc.property(specArb, fc.nat(), (spec, choice) => {
        const source = sourceOf(spec);
        const trace = new TraceRecorder();
        const module = lowerBoolean(source, { trace });
        const { circuit } = lowerToReversible(module, trace);
        if (circuit.gates.length === 0) return;

        const broken = dropGate(circuit, choice % circuit.gates.length);
        const report = verify(module, broken, estimateResources(broken), {
          compilerVersion: 'test',
          specHash: 'mutation',
          seed: 1,
        });

        if (report.passed) {
          // Allowed only if the mutant really is equivalent — some gates cancel, e.g. a
          // dropped compute gate on a node no output depends on. Prove it, don't assume it.
          for (const { bits, env } of assignments(spec)) {
            const state = run(broken, initialState(broken, bits));
            const observed = outputsByName(broken, state);
            for (const output of spec.outputs) expect(observed[output.name]).toBe(evalExpr(output.expr, env));
            expect(broken.ancillas.every((a) => state[a.wire] === 0)).toBe(true);
          }
          return;
        }

        const failure = report.checks.find((c) => c.status === 'failed')!;
        expect(['simulation_equivalence', 'garbage_free', 'reversibility']).toContain(failure.id);

        if (failure.counterexample) {
          // Re-simulate the exact assignment the report names and confirm the mismatch is
          // there. A counterexample that does not reproduce is worse than none at all.
          const { assignment, expected, observed } = failure.counterexample;
          const state = run(broken, initialState(broken, assignmentToBits(assignment, spec.names.length)));
          const actual = outputsByName(broken, state);
          const disagreement = Object.keys(expected).find((name) => expected[name] !== observed[name]);
          expect(disagreement, 'the reported counterexample records no disagreement').toBeDefined();
          expect(actual[disagreement!]).toBe(observed[disagreement!]);
          expect(actual[disagreement!]).not.toBe(expected[disagreement!]);
        }
      }),
      { numRuns: 200 },
    );
  });
});

/** The mutant: the same circuit with one gate removed. Structurally valid, semantically not. */
function dropGate(circuit: ReversibleCircuit, index: number): ReversibleCircuit {
  const gates: Gate[] = circuit.gates.filter((_, i) => i !== index);
  return { ...circuit, gates };
}
