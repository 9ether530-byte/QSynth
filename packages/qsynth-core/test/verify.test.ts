/**
 * The verification gate, including the deliberate failures.
 *
 * A check that has only ever been seen to pass is not evidence of anything: it might be
 * returning `passed` unconditionally. So for every check that *can* fail at this layer,
 * there is a test that breaks exactly one thing and asserts that the right check fails,
 * with usable evidence, and that the report refuses the circuit.
 *
 * Check 3 (reversibility) is the exception, and the exception is documented rather than
 * papered over — see the test at the bottom.
 */
import { describe, expect, it } from 'vitest';
import {
  assignmentToBits,
  CircuitBuilder,
  compile,
  COMPILER_VERSION,
  estimate,
  evaluate,
  initialState,
  invert,
  lowerBoolean,
  lowerToReversible,
  run,
  simulate,
  TraceRecorder,
  verify,
  type ClassicalModule,
  type Gate,
  type ReversibleCircuit,
  type VerificationReport,
} from '@qsynth/core';

function check(module: ClassicalModule, circuit: ReversibleCircuit, budget?: Parameters<typeof verify>[3]['budget']): VerificationReport {
  return verify(module, circuit, estimate(circuit), {
    compilerVersion: COMPILER_VERSION,
    specHash: 'test',
    seed: 7,
    budget,
  });
}

function statusOf(report: VerificationReport, id: string) {
  return report.checks.find((c) => c.id === id)!;
}

/**
 * A two-input circuit built with a caller-supplied compute rule. Injecting a wrong rule
 * here is the closest thing to a real lowering bug a test can produce.
 */
function handBuilt(
  computeRule: (builder: CircuitBuilder, a: number, b: number, target: number) => void,
  options: { uncompute?: boolean } = {},
): ReversibleCircuit {
  const builder = new CircuitBuilder('hand-built');
  const a = builder.addInput('a');
  const b = builder.addInput('b');
  const ancilla = builder.allocateAncilla('result', 0);
  const start = builder.gateCount;
  computeRule(builder, a, b, ancilla.wire);
  const end = builder.gateCount;
  const out = builder.addOutput('out');
  builder.emit('cnot', [ancilla.wire, out]);
  if (options.uncompute !== false) builder.emitInverseOf(start, end);
  return builder.build();
}

const XOR_SPEC = lowerBoolean('in a, b\nout = a XOR b');

describe('a correct circuit', () => {
  const module = lowerBoolean('in a, b, c\nout = (a AND b) XOR c');
  const { circuit } = lowerToReversible(module, new TraceRecorder());
  const report = check(module, circuit);

  it('passes', () => {
    expect(report.passed).toBe(true);
    expect(report.stoppedAt).toBeUndefined();
  });

  it('checks every input assignment exhaustively and says so', () => {
    const equivalence = statusOf(report, 'simulation_equivalence');
    expect(equivalence.coverage).toMatchObject({ mode: 'exhaustive', checked: 8, space: 8, dontCare: 0 });
    expect(equivalence.summary).toContain('all 8 of 8');
  });

  it('reports the checks it skipped, and why', () => {
    expect(report.checksReached).toEqual(['type_shape', 'simulation_equivalence', 'reversibility', 'garbage_free']);
    expect(statusOf(report, 'property').status).toBe('skipped');
    expect(statusOf(report, 'property').summary).toContain('declares no invariants');
    expect(statusOf(report, 'resource').summary).toContain('declares no resource budgets');
  });

  it('reaches all six checks when the spec declares invariants and budgets', () => {
    const withBoth = lowerBoolean('in a, b\nout = a XOR b\nassert sane: out OR NOT out');
    const built = lowerToReversible(withBoth, new TraceRecorder()).circuit;
    const full = check(withBoth, built, { maxQubits: 100, maxTCount: 100 });
    expect(full.checksReached).toHaveLength(6);
    expect(full.passed).toBe(true);
  });

  it('reports the ancilla ledger as evidence even on success', () => {
    const evidence = statusOf(report, 'garbage_free').evidence as { ancillas: { returnedToZero: boolean }[] };
    expect(evidence.ancillas).toHaveLength(circuit.ancillas.length);
    expect(evidence.ancillas.every((a) => a.returnedToZero)).toBe(true);
  });
});

describe('check 1 — type and shape', () => {
  const module = XOR_SPEC;
  const { circuit } = lowerToReversible(module, new TraceRecorder());

  it('fails on a gate referencing a wire that does not exist', () => {
    const broken: ReversibleCircuit = {
      ...circuit,
      gates: [...circuit.gates, { kind: 'cnot', wires: [0, 999] } as Gate],
    };
    const report = check(module, broken);
    expect(report.passed).toBe(false);
    expect(report.stoppedAt).toBe('type_shape');
    expect(statusOf(report, 'type_shape').summary).toContain('wire 999');
  });

  it('fails on wrong arity', () => {
    const broken: ReversibleCircuit = { ...circuit, gates: [{ kind: 'ccnot', wires: [0, 1] } as Gate] };
    expect(statusOf(check(module, broken), 'type_shape').summary).toContain('expected 3');
  });

  it('fails when a gate writes to an input wire', () => {
    const inputWire = circuit.inputs[0]!.wire;
    const broken: ReversibleCircuit = {
      ...circuit,
      gates: [...circuit.gates, { kind: 'x', wires: [inputWire] } as Gate],
    };
    expect(statusOf(check(module, broken), 'type_shape').summary).toContain('writes to input wire');
  });

  it('short-circuits: nothing after it runs', () => {
    const broken: ReversibleCircuit = { ...circuit, gates: [{ kind: 'ccnot', wires: [0, 1] } as Gate] };
    const report = check(module, broken);
    expect(report.checksReached).toEqual(['type_shape']);
    for (const id of ['simulation_equivalence', 'reversibility', 'garbage_free', 'property', 'resource']) {
      expect(statusOf(report, id).status).toBe('skipped');
      expect(statusOf(report, id).summary).toContain('type and shape');
    }
  });
});

describe('check 2 — simulation equivalence', () => {
  it('fails when a lowering rule is wrong, and the counterexample reproduces', () => {
    // A plausible bug: the XOR rule forgets its second CNOT, so out = a, not a XOR b.
    const circuit = handBuilt((builder, a, _b, target) => {
      builder.emit('cnot', [a, target]);
    });
    const report = check(XOR_SPEC, circuit);

    expect(report.passed).toBe(false);
    expect(report.stoppedAt).toBe('simulation_equivalence');

    const counterexample = statusOf(report, 'simulation_equivalence').counterexample!;
    expect(counterexample).toBeDefined();

    // The counterexample is only useful if replaying it produces the reported values.
    const bits = assignmentToBits(counterexample.assignment, XOR_SPEC.inputs.length);
    expect(bits).toEqual(XOR_SPEC.inputs.map((i) => counterexample.inputs[i.name]));
    expect(simulate(circuit, bits).outputs[0]).toBe(counterexample.observed.out);
    expect(evaluate(XOR_SPEC, bits).outputs.out).toBe(counterexample.expected.out);
    expect(counterexample.expected.out).not.toBe(counterexample.observed.out);
  });

  it('names the inputs the user named, not wire indices', () => {
    const circuit = handBuilt((builder, a, _b, target) => builder.emit('cnot', [a, target]));
    const counterexample = statusOf(check(XOR_SPEC, circuit), 'simulation_equivalence').counterexample!;
    expect(Object.keys(counterexample.inputs).sort()).toEqual(['a', 'b']);
  });

  it('does not check assignments the specification left unconstrained', () => {
    // A table with the 11 row omitted: the circuit may do anything there.
    const result = compile({ kind: 'truthtable', source: 'a b | out\n0 0 | 0\n0 1 | 1\n1 0 | 1\n' });
    const equivalence = result.report.checks.find((c) => c.id === 'simulation_equivalence')!;
    expect(equivalence.status).toBe('passed');
    expect(equivalence.coverage).toMatchObject({ checked: 3, space: 4, dontCare: 1 });
    expect(equivalence.summary).toContain('1 unconstrained');
  });

  it('samples with a recorded seed when the input space is too large to enumerate', () => {
    const inputs = Array.from({ length: 14 }, (_, i) => `a${i}`);
    const source = `in ${inputs.join(', ')}\nout = ${inputs.join(' XOR ')}`;
    const result = compile({ kind: 'boolean', source, sampleCount: 512 });
    const coverage = result.report.checks.find((c) => c.id === 'simulation_equivalence')!.coverage!;

    expect(coverage.mode).toBe('sampled');
    expect(coverage.checked).toBe(512);
    expect(coverage.space).toBe(2 ** 14);
    expect(coverage.seed).toBeTypeOf('number');
    expect(result.report.passed).toBe(true);

    // Same spec, same seed, same sample — otherwise the recorded seed proves nothing.
    const again = compile({ kind: 'boolean', source, sampleCount: 512 });
    expect(again.report.checks.find((c) => c.id === 'simulation_equivalence')!.coverage).toEqual(coverage);
  });
});

describe('check 4 — garbage-free ancillas', () => {
  it('fails when the uncompute block is missing, while equivalence still passes', () => {
    // This is the ordering the check sequence exists for: the circuit computes the right
    // answer and still must not be exported, because it leaves entangled garbage behind.
    const circuit = handBuilt(
      (builder, a, b, target) => {
        builder.emit('cnot', [a, target]);
        builder.emit('cnot', [b, target]);
      },
      { uncompute: false },
    );
    const report = check(XOR_SPEC, circuit);

    expect(statusOf(report, 'simulation_equivalence').status).toBe('passed');
    expect(report.stoppedAt).toBe('garbage_free');
    expect(report.passed).toBe(false);
  });

  it('reports per-ancilla, naming the wire and its purpose', () => {
    const circuit = handBuilt((builder, a, b, target) => {
      builder.emit('cnot', [a, target]);
      builder.emit('cnot', [b, target]);
    }, { uncompute: false });
    const result = statusOf(check(XOR_SPEC, circuit), 'garbage_free');
    const evidence = result.evidence as { ancillas: { wire: number; purpose: string; returnedToZero: boolean; dirtyOnAssignments?: number }[] };

    expect(evidence.ancillas).toHaveLength(1);
    expect(evidence.ancillas[0]).toMatchObject({ wire: 2, purpose: 'result', returnedToZero: false });
    expect(evidence.ancillas[0]!.dirtyOnAssignments).toBe(2); // a XOR b is 1 on two of four assignments
    expect(result.summary).toContain('result');
  });

  it('fails when an input is disturbed', () => {
    const builder = new CircuitBuilder('disturbs-input');
    const a = builder.addInput('a');
    const b = builder.addInput('b');
    const ancilla = builder.allocateAncilla('result', 0);
    builder.emit('cnot', [a, ancilla.wire]);
    builder.emit('cnot', [b, ancilla.wire]);
    const out = builder.addOutput('out');
    builder.emit('cnot', [ancilla.wire, out]);
    builder.emit('cnot', [b, ancilla.wire]);
    builder.emit('cnot', [a, ancilla.wire]);
    builder.emit('x', [a]); // the bug
    const circuit = builder.build();

    const report = check(XOR_SPEC, circuit);
    // Writing to an input is caught by the shape check before simulation gets a chance —
    // the cheaper check owns the failure, which is the point of the ordering.
    expect(report.stoppedAt).toBe('type_shape');
    expect(statusOf(report, 'type_shape').summary).toContain('writes to input wire');
  });
});

describe('check 5 — declared properties', () => {
  it('fails on an invariant that does not hold, with a counterexample', () => {
    const result = compile({ kind: 'boolean', source: 'in a, b\nout = a AND b\nassert always: a OR b' });
    expect(result.report.passed).toBe(false);
    expect(result.report.stoppedAt).toBe('property');

    const property = result.report.checks.find((c) => c.id === 'property')!;
    expect(property.counterexample!.inputs).toEqual({ a: 0, b: 0 });
    expect(property.summary).toContain('always');
    const evidence = property.evidence as { assertions: { name: string; held: boolean; violatedOnAssignments?: number }[] };
    expect(evidence.assertions[0]).toMatchObject({ name: 'always', held: false, violatedOnAssignments: 1 });
  });

  it('passes on an invariant that holds everywhere', () => {
    const result = compile({ kind: 'boolean', source: 'in a, b\nsum = a XOR b\nassert tautology: sum OR NOT sum' });
    expect(result.report.passed).toBe(true);
    expect(result.report.checks.find((c) => c.id === 'property')!.summary).toContain('1 declared invariant');
  });

  it('checks each declared invariant separately', () => {
    const result = compile({
      kind: 'boolean',
      source: 'in a, b\nout = a AND b\nassert holds: a OR NOT a\nassert fails: a AND b',
    });
    const evidence = result.report.checks.find((c) => c.id === 'property')!.evidence as {
      assertions: { name: string; held: boolean }[];
    };
    expect(evidence.assertions.map((x) => [x.name, x.held])).toEqual([
      ['holds', true],
      ['fails', false],
    ]);
  });
});

describe('check 6 — resource budgets', () => {
  const module = lowerBoolean('in a, b, c\nout = (a AND b) OR c');
  const { circuit } = lowerToReversible(module, new TraceRecorder());
  const measured = estimate(circuit);

  it('fails when a declared budget is exceeded, quoting both figures', () => {
    const report = check(module, circuit, { maxQubits: 4 });
    expect(report.passed).toBe(false);
    expect(report.stoppedAt).toBe('resource');

    const resource = statusOf(report, 'resource');
    expect(resource.summary).toContain(`qubits is ${measured.qubits}`);
    expect(resource.summary).toContain('budget is 4');
    expect(resource.evidence).toMatchObject({
      comparisons: [{ budget: 'maxQubits', limit: 4, actual: measured.qubits, withinBudget: false }],
    });
  });

  it('marks projected figures as projected, so a T-count budget is not mistaken for a measurement', () => {
    const report = check(module, circuit, { maxTCount: 1 });
    const comparisons = (statusOf(report, 'resource').evidence as { comparisons: { budget: string; projected: boolean }[] }).comparisons;
    expect(comparisons[0]).toMatchObject({ budget: 'maxTCount', projected: true });
  });

  it('passes when every declared budget is met, and ignores the ones not declared', () => {
    const report = check(module, circuit, { maxQubits: 100 });
    expect(report.passed).toBe(true);
    expect(statusOf(report, 'resource').summary).toContain('All 1 declared budget');
  });

  it('treats an undeclared budget as no budget, not as zero', () => {
    expect(check(module, circuit, {}).passed).toBe(true);
    expect(statusOf(check(module, circuit, {}), 'resource').status).toBe('skipped');
  });
});

describe('check 3 — reversibility', () => {
  const module = XOR_SPEC;
  const { circuit } = lowerToReversible(module, new TraceRecorder());

  it('passes exactly, with no numerical tolerance', () => {
    const result = statusOf(check(module, circuit), 'reversibility');
    expect(result.status).toBe('passed');
    expect(result.evidence).toMatchObject({ tolerance: 'exact' });
  });

  it('cannot be made to fail at this layer — and the detection it performs still works', () => {
    // Every gate in the Reversible IR is its own inverse and `invert` reverses the order,
    // so U·U† = I holds for *any* circuit this compiler can build. There is no input that
    // makes this check fail here; the failure mode it guards against belongs to the
    // Clifford+T layer, where gates are not involutions.
    //
    // What can be tested is that the comparison itself detects a broken inverse. A
    // "inverse" with one gate dropped must not return the state.
    const start = initialState(circuit, [1, 0]);
    const correct = Uint8Array.from(start);
    run(circuit, correct);
    run(invert(circuit), correct);
    expect([...correct]).toEqual([...start]);

    const brokenInverse: ReversibleCircuit = { ...circuit, gates: invert(circuit).gates.slice(1) };
    const damaged = Uint8Array.from(start);
    run(circuit, damaged);
    run(brokenInverse, damaged);
    expect([...damaged]).not.toEqual([...start]);
  });
});

describe('the report as a whole', () => {
  it('is attributable to a compiler version and a spec', () => {
    const result = compile({ kind: 'boolean', source: 'out = a AND b' });
    expect(result.report.compilerVersion).toBe(COMPILER_VERSION);
    expect(result.report.specHash).toBe(result.specHash);
  });

  it('records a duration for every check that ran', () => {
    const result = compile({ kind: 'boolean', source: 'out = a AND b' });
    for (const id of result.report.checksReached) {
      expect(result.report.checks.find((c) => c.id === id)!.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('never reports passed alongside a failed check', () => {
    const result = compile({ kind: 'boolean', source: 'in a\nout = a\nassert no: a AND NOT a' });
    expect(result.report.passed).toBe(false);
    expect(result.report.checks.some((c) => c.status === 'failed')).toBe(true);
  });
});
