/**
 * The optimizer, and the guard that is supposed to make it safe.
 *
 * Two halves. The first tests each pass on a circuit built to make it fire, and tests the
 * renumbering machinery underneath them directly, because a ledger that points at the
 * wrong gate is the kind of bug that never produces a wrong answer — only a wrong
 * explanation of a right one, which is worse, since nothing fails.
 *
 * The second half is the one that matters. A guard that has only ever been run against
 * correct passes is not evidence of anything: it might be returning "equivalent"
 * unconditionally. So the suite includes passes that are knowingly wrong — one that
 * corrupts an output, one that disturbs an input, one that strands an ancilla — and
 * asserts that each is caught, discarded, and reported with a counterexample that
 * reproduces.
 */
import { describe, expect, it } from 'vitest';
import {
  cancelInverses,
  CircuitBuilder,
  compile,
  constantFold,
  depth,
  dropUnusedAncillas,
  dropWires,
  estimateOnly,
  lowerBoolean,
  lowerToReversible,
  optimize,
  OPTIMIZATION_PASSES,
  planAssignments,
  reuseValues,
  rewriteGates,
  simulate,
  TraceRecorder,
  type ClassicalModule,
  type Gate,
  type GateRewrite,
  type OptimizationSummary,
  type Pass,
  type ReversibleCircuit,
} from '@qsynth/core';

function lower(source: string): { module: ClassicalModule; circuit: ReversibleCircuit } {
  const module = lowerBoolean(source);
  return { module, circuit: lowerToReversible(module, new TraceRecorder()).circuit };
}

function run(module: ClassicalModule, circuit: ReversibleCircuit, passes: readonly Pass[]) {
  return optimize(module, circuit, { plan: planAssignments(module, { seed: 1 }), passes });
}

function outcomeOf(summary: OptimizationSummary, id: string) {
  return summary.passes.find((p) => p.id === id)!;
}

/** Toffolis, which is what a T count is a proxy for at this layer. */
function toffolis(circuit: ReversibleCircuit): number {
  return circuit.gates.filter((g) => g.kind === 'ccnot' || g.kind === 'cswap').length;
}

/**
 * What the circuit does, for every input assignment, as a flat string.
 *
 * Ancillas are counted, not listed, for the same reason the guard counts them: removing a
 * wire that held |0⟩ throughout narrows the state without changing anything observable,
 * and a comparison that listed ancillas per-wire would call that a behaviour change and
 * make `drop-unused-ancillas` untestable. What is kept is what the checks test — the
 * outputs, the inputs still holding their values, and no ancilla left dirty.
 */
function behaviour(circuit: ReversibleCircuit, inputCount: number): string {
  const rows: string[] = [];
  for (let a = 0; a < 2 ** inputCount; a++) {
    const bits = Array.from({ length: inputCount }, (_, i) => ((a >> i) & 1) as 0 | 1);
    const result = simulate(circuit, bits);
    const dirty = result.ancillasAtEnd.filter((value) => value !== 0).length;
    rows.push(`${a}:${result.outputs.join('')}|${result.inputsAtEnd.join('')}|${dirty}`);
  }
  return rows.join(' ');
}

describe('rewriteGates', () => {
  /** Two ancillas, gates at known positions, so the renumbering is checkable by hand. */
  function ledgerCircuit(): ReversibleCircuit {
    const builder = new CircuitBuilder('ledger');
    const a = builder.addInput('a');
    const first = builder.allocateAncilla('first', 0); // allocatedAtGate 0
    builder.emit('cnot', [a, first.wire]); // gate 0
    builder.emit('x', [first.wire]); // gate 1
    const second = builder.allocateAncilla('second', 1); // allocatedAtGate 2
    builder.emit('cnot', [first.wire, second.wire]); // gate 2
    builder.emit('x', [first.wire]); // gate 3
    first.uncomputedAtGate = 3;
    first.releasedAtGate = 3;
    const out = builder.addOutput('out');
    builder.emit('cnot', [second.wire, out]); // gate 4
    second.uncomputedAtGate = 4;
    return builder.build();
  }

  it('drops the gates the plan nulls and keeps the rest in order', () => {
    const circuit = ledgerCircuit();
    const rewrites: GateRewrite[] = [circuit.gates[0]!, null, circuit.gates[2]!, null, circuit.gates[4]!];
    const next = rewriteGates(circuit, rewrites);
    expect(next.gates).toHaveLength(3);
    expect(next.gates.map((g) => g.kind)).toEqual(['cnot', 'cnot', 'cnot']);
  });

  it('moves every ledger index to the number of gates that survive before it', () => {
    const circuit = ledgerCircuit();
    // Drop gates 1 and 3. Survivors before each old index: 0→0, 2→1, 3→2, 4→2.
    const next = rewriteGates(circuit, [circuit.gates[0]!, null, circuit.gates[2]!, null, circuit.gates[4]!]);
    expect(next.ancillas[0]).toMatchObject({ allocatedAtGate: 0, uncomputedAtGate: 2, releasedAtGate: 2 });
    expect(next.ancillas[1]).toMatchObject({ allocatedAtGate: 1, uncomputedAtGate: 2 });
  });

  it('maps an index that pointed one past the last gate to the new end', () => {
    const circuit = ledgerCircuit();
    const atEnd: ReversibleCircuit = {
      ...circuit,
      ancillas: [{ ...circuit.ancillas[0]!, allocatedAtGate: circuit.gates.length }],
    };
    const next = rewriteGates(atEnd, [null, null, null, null, null]);
    expect(next.gates).toHaveLength(0);
    expect(next.ancillas[0]!.allocatedAtGate).toBe(0);
  });

  it('leaves a null uncompute point null rather than inventing a position for it', () => {
    const circuit = ledgerCircuit();
    const next = rewriteGates(circuit, [circuit.gates[0]!, null, ...circuit.gates.slice(2)]);
    expect(next.ancillas[1]!.releasedAtGate).toBeNull();
  });

  it('returns the identical object when the plan changes nothing, so a pass reads as no-change', () => {
    const circuit = ledgerCircuit();
    expect(rewriteGates(circuit, [...circuit.gates])).toBe(circuit);
  });

  it('refuses a plan of the wrong length', () => {
    const circuit = ledgerCircuit();
    expect(() => rewriteGates(circuit, [null])).toThrow(/plan has 1 entries for 5 gates/);
  });
});

describe('dropWires', () => {
  function twoAncillas(): ReversibleCircuit {
    const builder = new CircuitBuilder('drop');
    const a = builder.addInput('a');
    const unused = builder.allocateAncilla('unused', 0);
    const used = builder.allocateAncilla('used', 1);
    const out = builder.addOutput('out');
    builder.emit('cnot', [a, used.wire]);
    builder.emit('cnot', [used.wire, out]);
    builder.emit('cnot', [a, used.wire]);
    void unused;
    return builder.build();
  }

  it('renumbers gates, inputs, outputs and the ledger together', () => {
    const circuit = twoAncillas();
    const next = dropWires(circuit, new Set([1]));
    expect(next.wires.map((w) => w.index)).toEqual([0, 1, 2]);
    expect(next.inputs[0]!.wire).toBe(0);
    expect(next.outputs[0]!.wire).toBe(2);
    expect(next.ancillas).toHaveLength(1);
    expect(next.ancillas[0]!.wire).toBe(1);
    expect(next.gates.map((g) => g.wires)).toEqual([
      [0, 1],
      [1, 2],
      [0, 1],
    ]);
  });

  it('refuses to remove a wire a gate still names', () => {
    expect(() => dropWires(twoAncillas(), new Set([2]))).toThrow(/still referenced/);
  });

  it('is the identity when nothing is removed', () => {
    const circuit = twoAncillas();
    expect(dropWires(circuit, new Set())).toBe(circuit);
  });
});

describe('cancel-inverses', () => {
  it('cancels a pair separated only by gates on other wires', () => {
    const builder = new CircuitBuilder('separated');
    const a = builder.addInput('a');
    const b = builder.addInput('b');
    const out = builder.addOutput('out');
    const scratch = builder.allocateAncilla('scratch', 0);
    builder.emit('x', [scratch.wire]);
    builder.emit('cnot', [a, out]); // touches neither scratch nor itself
    builder.emit('cnot', [b, out]);
    builder.emit('x', [scratch.wire]);
    const circuit = builder.build();

    const next = cancelInverses.run(circuit);
    expect(next.gates).toHaveLength(2);
    expect(next.gates.every((g) => g.kind === 'cnot')).toBe(true);
  });

  it('cancels a Toffoli against the same Toffoli with its controls written the other way round', () => {
    const builder = new CircuitBuilder('commuted-controls');
    const a = builder.addInput('a');
    const b = builder.addInput('b');
    const target = builder.addOutput('out');
    builder.emit('ccnot', [a, b, target]);
    builder.emit('ccnot', [b, a, target]);
    expect(cancelInverses.run(builder.build()).gates).toHaveLength(0);
  });

  it('will not cancel across a gate that writes a wire it reads', () => {
    const builder = new CircuitBuilder('blocked');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const scratch = builder.allocateAncilla('scratch', 0);
    builder.emit('cnot', [scratch.wire, out]);
    builder.emit('x', [scratch.wire]); // writes the control of both neighbours
    builder.emit('cnot', [scratch.wire, out]);
    const circuit = builder.build();

    // The two CNOTs are *not* the same operation here — the X between them changes what
    // the second one does — so the pass must leave all three alone.
    expect(cancelInverses.run(circuit)).toBe(circuit);
  });

  it('finds nothing in Bennett form, because the copy-out is always in the way', () => {
    // Stated as a test rather than left as a surprise. Lowering emits compute, copy-out,
    // uncompute — and the copy-out reads the very wire the two halves bracket, so they
    // cannot slide together. This pass is here for hand-written and re-imported circuits.
    const { circuit } = lower('in a, b, c\nout = (a AND b) XOR c');
    expect(cancelInverses.run(circuit)).toBe(circuit);
  });
});

describe('constant-fold', () => {
  it('drops a gate whose control is an ancilla nothing has written yet', () => {
    const builder = new CircuitBuilder('zero-control');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const scratch = builder.allocateAncilla('scratch', 0);
    builder.emit('ccnot', [scratch.wire, a, out]); // scratch is |0⟩: cannot fire
    builder.emit('cnot', [a, out]);
    const next = constantFold.run(builder.build());
    expect(next.gates).toHaveLength(1);
    expect(next.gates[0]!.kind).toBe('cnot');
  });

  it('walks a Toffoli down to a CNOT and a CNOT down to an X as controls resolve to one', () => {
    const builder = new CircuitBuilder('one-control');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const one = builder.allocateAncilla('one', 0);
    builder.emit('x', [one.wire]); // now provably |1⟩
    builder.emit('ccnot', [one.wire, a, out]); // → cnot a → out
    builder.emit('cnot', [one.wire, out]); // → x out
    const next = constantFold.run(builder.build());
    expect(next.gates.map((g) => g.kind)).toEqual(['x', 'cnot', 'x']);
    expect(next.gates[1]!.wires).toEqual([a, out]);
    expect(next.gates[2]!.wires).toEqual([out]);
  });

  it('keeps the surviving control when the folded one was written second', () => {
    const builder = new CircuitBuilder('second-control');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const one = builder.allocateAncilla('one', 0);
    builder.emit('x', [one.wire]);
    builder.emit('ccnot', [a, one.wire, out]);
    const next = constantFold.run(builder.build());
    expect(next.gates[1]!.wires).toEqual([a, out]);
  });

  it('follows values across a Fredkin whose control is known', () => {
    const builder = new CircuitBuilder('fredkin');
    const out = builder.addOutput('out');
    const one = builder.allocateAncilla('one', 0);
    const flag = builder.allocateAncilla('flag', 1);
    builder.emit('x', [one.wire]);
    builder.emit('x', [flag.wire]);
    // The control is |1⟩, so the swap definitely happens: `flag` becomes |0⟩ and `out`
    // becomes |1⟩. A pass that stopped analysing here would lose both facts.
    builder.emit('cswap', [one.wire, flag.wire, out]);
    builder.emit('cnot', [flag.wire, out]); // control now |0⟩ — dropped
    builder.emit('cnot', [out, flag.wire]); // control now |1⟩ — becomes an X
    const next = constantFold.run(builder.build());
    expect(next.gates.map((g) => g.kind)).toEqual(['x', 'x', 'cswap', 'x']);
    expect(next.gates[3]!.wires).toEqual([flag.wire]);
  });

  it('does not fold a control the circuit has made unknown', () => {
    const builder = new CircuitBuilder('unknown');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const scratch = builder.allocateAncilla('scratch', 0);
    builder.emit('cnot', [a, scratch.wire]); // scratch now depends on an input
    builder.emit('cnot', [scratch.wire, out]);
    const circuit = builder.build();
    expect(constantFold.run(circuit)).toBe(circuit);
  });

  it('preserves what a real lowered circuit computes', () => {
    const { module, circuit } = lower('in a, b\nout = a AND 0\nsecond = a OR b');
    const next = constantFold.run(circuit);
    expect(behaviour(next, module.inputs.length)).toBe(behaviour(circuit, module.inputs.length));
  });
});

describe('reuse-values', () => {
  it('turns the second computation of a shared sub-expression into a CNOT', () => {
    const { module, circuit } = lower('in a, b, c\nout = (a AND b) XOR c\ncarry = a AND b');
    const next = reuseValues.run(circuit);

    // Same number of gates, a quarter of the Toffolis: `a AND b` is lowered four times
    // across the compute and uncompute halves, and only the first one has to be a Toffoli.
    expect(next.gates).toHaveLength(circuit.gates.length);
    expect(toffolis(circuit)).toBe(4);
    expect(toffolis(next)).toBe(1);
    expect(behaviour(next, module.inputs.length)).toBe(behaviour(circuit, module.inputs.length));
  });

  it('drops a gate whose effect is the zero function', () => {
    const builder = new CircuitBuilder('never-fires');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const scratch = builder.allocateAncilla('scratch', 0);
    builder.emit('ccnot', [scratch.wire, a, out]); // scratch is |0⟩ for every assignment
    const next = reuseValues.run(builder.build());
    expect(next.gates).toHaveLength(0);
  });

  it('turns a gate whose effect is the constant one into an X', () => {
    const builder = new CircuitBuilder('always-fires');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const one = builder.allocateAncilla('one', 0);
    builder.emit('x', [one.wire]);
    builder.emit('ccnot', [one.wire, a, out]); // → cnot from a
    builder.emit('cnot', [one.wire, out]); // → x
    const next = reuseValues.run(builder.build());
    expect(next.gates.map((g) => g.kind)).toEqual(['x', 'cnot', 'x']);
    expect(next.gates[1]!.wires).toEqual([a, out]);
  });

  it('drops a Fredkin whose targets always agree', () => {
    const builder = new CircuitBuilder('pointless-swap');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const left = builder.allocateAncilla('left', 0);
    const right = builder.allocateAncilla('right', 1);
    builder.emit('cnot', [a, left.wire]);
    builder.emit('cnot', [a, right.wire]); // both hold `a`, so swapping them is a no-op
    builder.emit('cswap', [out, left.wire, right.wire]);
    const next = reuseValues.run(builder.build());
    expect(next.gates.map((g) => g.kind)).toEqual(['cnot', 'cnot']);
  });

  it('never makes a gate more expensive than the one it replaces', () => {
    const { module, circuit } = lower('in a, b, c, d\nout = (a AND b) OR (c AND d)\nsecond = a XOR d');
    const next = reuseValues.run(circuit);
    expect(next.gates).toHaveLength(circuit.gates.length);
    expect(toffolis(next)).toBeLessThanOrEqual(toffolis(circuit));
    expect(behaviour(next, module.inputs.length)).toBe(behaviour(circuit, module.inputs.length));
  });

  it('declines rather than guesses when the truth table would not fit', () => {
    // Fourteen inputs puts the table past the exhaustive limit, where it would have to be
    // sampled — and a sampled table turns a proof into a guess.
    const names = Array.from({ length: 14 }, (_, i) => `i${i}`);
    const { circuit } = lower(`in ${names.join(', ')}\nout = ${names.join(' XOR ')}`);
    expect(reuseValues.run(circuit)).toBe(circuit);
  });
});

describe('drop-unused-ancillas', () => {
  it('removes an ancilla no gate touches', () => {
    const builder = new CircuitBuilder('unused');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    builder.allocateAncilla('never-used', 0);
    builder.emit('cnot', [a, out]);
    const next = dropUnusedAncillas.run(builder.build());
    expect(next.wires).toHaveLength(2);
    expect(next.ancillas).toHaveLength(0);
  });

  it('leaves an unused input or output wire alone — they are the declared interface', () => {
    const builder = new CircuitBuilder('unused-input');
    builder.addInput('a');
    builder.addInput('unread');
    builder.addOutput('out');
    builder.emit('cnot', [0, 2]);
    const circuit = builder.build();
    expect(dropUnusedAncillas.run(circuit)).toBe(circuit);
  });

  it('collects what the earlier passes strand', () => {
    const builder = new CircuitBuilder('stranded');
    const a = builder.addInput('a');
    const out = builder.addOutput('out');
    const scratch = builder.allocateAncilla('scratch', 0);
    builder.emit('x', [scratch.wire]);
    builder.emit('x', [scratch.wire]); // cancels, stranding the ancilla
    builder.emit('cnot', [a, out]);
    const circuit = builder.build();

    expect(dropUnusedAncillas.run(circuit)).toBe(circuit);
    const cancelled = cancelInverses.run(circuit);
    expect(dropUnusedAncillas.run(cancelled).wires).toHaveLength(2);
  });
});

describe('the pipeline', () => {
  const { module, circuit } = lower('in a, b, c\nout = (a AND b) XOR c\ncarry = a AND b');
  const result = run(module, circuit, OPTIMIZATION_PASSES);

  it('produces a cheaper circuit that computes the same thing', () => {
    expect(toffolis(result.circuit)).toBeLessThan(toffolis(circuit));
    expect(behaviour(result.circuit, module.inputs.length)).toBe(behaviour(circuit, module.inputs.length));
  });

  it('removes gates and qubits too, when the specification gives it something to remove', () => {
    const constants = lower('in a, b\nout = a AND 0\nsecond = a OR b');
    const folded = run(constants.module, constants.circuit, OPTIMIZATION_PASSES);
    expect(folded.summary.after.gates).toBeLessThan(folded.summary.before.gates);
    expect(folded.summary.after.qubits).toBeLessThan(folded.summary.before.qubits);
    expect(behaviour(folded.circuit, 2)).toBe(behaviour(constants.circuit, 2));
  });

  it('measures each pass rather than believing it', () => {
    for (const outcome of result.summary.passes) {
      if (outcome.status === 'no_change') {
        // The runner derives this from the circuits, not from anything the pass said.
        expect(outcome.after).toEqual(outcome.before);
        continue;
      }
      // No pass in this pipeline is allowed to grow the circuit. A rewrite that trades a
      // Toffoli for a CNOT leaves both counts equal and is still an improvement, so the
      // bound is non-increase rather than strict decrease.
      expect(outcome.after.gates).toBeLessThanOrEqual(outcome.before.gates);
      expect(outcome.after.qubits).toBeLessThanOrEqual(outcome.before.qubits);
    }
  });

  it('records the coverage the guard actually achieved', () => {
    expect(result.summary.guard).toMatchObject({ mode: 'exhaustive', checked: 8, space: 8 });
  });

  it('discards nothing, because every pass in the pipeline is meant to be correct', () => {
    expect(result.summary.discarded).toBe(0);
    expect(result.summary.passes.map((p) => p.id)).toEqual(OPTIMIZATION_PASSES.map((p) => p.id));
  });

  it('reports a pass that rebuilt an identical circuit as no-change, not as applied', () => {
    const rebuild: Pass = {
      id: 'rebuild',
      title: 'Rebuild',
      rationale: 'Returns a structurally identical circuit through a different object.',
      run: (input) => ({ ...input, gates: input.gates.map((g) => g) }),
    };
    const summary = run(module, circuit, [rebuild]).summary;
    expect(outcomeOf(summary, 'rebuild').status).toBe('no_change');
  });
});

/**
 * The deliberate failures. Each pass below is wrong on purpose, in a different way, and
 * the point of the test is not that the pass is wrong — it is that the compiler notices
 * without being told, keeps the circuit it had, and can say which input proves it.
 */
describe('the equivalence guard', () => {
  const { module, circuit } = lower('in a, b, c\nout = (a AND b) XOR c');

  /** Deletes the copy-out, so the output wire stays |0⟩ for every input. */
  const corruptOutput: Pass = {
    id: 'corrupt-output',
    title: 'Knowingly wrong: drop the copy-out',
    rationale: 'Deliberately breaks the circuit so the guard has something real to catch.',
    run(input) {
      const outputWires = new Set(input.outputs.map((o) => o.wire));
      const rewrites: GateRewrite[] = input.gates.map((gate) =>
        outputWires.has(gate.wires[gate.wires.length - 1]!) ? null : gate,
      );
      return rewriteGates(input, rewrites);
    },
  };

  /** Writes to an input wire, which breaks the Bennett form without touching an output. */
  const disturbInput: Pass = {
    id: 'disturb-input',
    title: 'Knowingly wrong: flip an input at the end',
    rationale: 'Deliberately breaks the circuit so the guard has something real to catch.',
    run: (input) => ({ ...input, gates: [...input.gates, { kind: 'x', wires: [input.inputs[0]!.wire] } as Gate] }),
  };

  /** Removes the uncompute half, leaving every ancilla holding its scratch value. */
  const strandAncilla: Pass = {
    id: 'strand-ancilla',
    title: 'Knowingly wrong: skip the uncompute',
    rationale: 'Deliberately breaks the circuit so the guard has something real to catch.',
    run(input) {
      const outputWires = new Set(input.outputs.map((o) => o.wire));
      const lastCopyOut = input.gates.reduce<number>(
        (last, gate, i) => (outputWires.has(gate.wires[gate.wires.length - 1]!) ? i : last),
        -1,
      );
      return { ...input, gates: input.gates.slice(0, lastCopyOut + 1) };
    },
  };

  it('catches a pass that changes an output, and keeps the circuit it was given', () => {
    const { circuit: kept, summary } = run(module, circuit, [corruptOutput]);
    const outcome = outcomeOf(summary, 'corrupt-output');

    expect(outcome.status).toBe('discarded');
    expect(summary.discarded).toBe(1);
    expect(kept).toBe(circuit);
    expect(summary.after).toEqual(summary.before);
    expect(outcome.after).toEqual(outcome.before);
    expect(outcome.divergence!.detail).toContain('output "out"');
  });

  it('hands back a counterexample that reproduces', () => {
    const divergence = outcomeOf(run(module, circuit, [corruptOutput]).summary, 'corrupt-output').divergence!;
    const bits = Array.from({ length: module.inputs.length }, (_, i) => ((divergence.assignment >> i) & 1) as 0 | 1);

    // Run both circuits on the named assignment and confirm the report told the truth.
    const good = simulate(circuit, bits);
    const bad = simulate(corruptOutput.run(circuit), bits);
    expect(good.outputs).not.toEqual(bad.outputs);
    expect(divergence.expected['out']).toBe(good.outputs[0]);
    expect(divergence.observed['out']).toBe(bad.outputs[0]);
    module.inputs.forEach((input, i) => expect(divergence.inputs[input.name]).toBe(bits[i]));
  });

  it('catches a pass that disturbs an input even though every output is still right', () => {
    const { circuit: kept, summary } = run(module, circuit, [disturbInput]);
    const outcome = outcomeOf(summary, 'disturb-input');
    expect(outcome.status).toBe('discarded');
    expect(kept).toBe(circuit);
    expect(outcome.divergence!.detail).toContain('Bennett form');
  });

  it('catches a pass that strands an ancilla', () => {
    const { circuit: kept, summary } = run(module, circuit, [strandAncilla]);
    const outcome = outcomeOf(summary, 'strand-ancilla');
    expect(outcome.status).toBe('discarded');
    expect(kept).toBe(circuit);
    expect(outcome.divergence!.detail).toContain('finished dirty');
  });

  it('keeps going after a discard, so one bad pass does not cost the good ones', () => {
    const shared = lower('in a, b, c\nout = (a AND b) XOR c\ncarry = a AND b');
    const { circuit: optimized, summary } = run(shared.module, shared.circuit, [
      corruptOutput,
      ...OPTIMIZATION_PASSES,
    ]);
    expect(summary.discarded).toBe(1);
    expect(toffolis(optimized)).toBeLessThan(toffolis(shared.circuit));
    expect(behaviour(optimized, 3)).toBe(behaviour(shared.circuit, 3));
  });

  it('judges every pass against the original circuit, not against the pass before it', () => {
    // `corruptOutput` after a good pass has already run must still be measured against
    // what lowering produced — otherwise a chain of passes could drift one step at a time.
    const shared = lower('in a, b, c\nout = (a AND b) XOR c\ncarry = a AND b');
    const { circuit: kept, summary } = run(shared.module, shared.circuit, [reuseValues, corruptOutput]);
    expect(outcomeOf(summary, 'reuse-values').status).toBe('applied');
    expect(outcomeOf(summary, 'corrupt-output').status).toBe('discarded');
    expect(behaviour(kept, 3)).toBe(behaviour(shared.circuit, 3));
  });

  it('preserves wrongness rather than judging it — that is check 2\'s job', () => {
    // A circuit that computes AND where the module says XOR. The guard has no opinion:
    // it only asks whether the rewrite changed the answer, and dropping a doubled X does
    // not. The circuit is still wrong afterwards, and check 2 is what says so.
    const builder = new CircuitBuilder('wrong-on-purpose');
    const a = builder.addInput('a');
    const b = builder.addInput('b');
    const out = builder.addOutput('out');
    builder.emit('x', [out]);
    builder.emit('x', [out]); // cancels
    builder.emit('ccnot', [a, b, out]); // AND, not XOR
    const wrong = builder.build();

    const xorModule = lowerBoolean('in a, b\nout = a XOR b');
    const { circuit: optimized, summary } = run(xorModule, wrong, OPTIMIZATION_PASSES);
    expect(summary.discarded).toBe(0);
    expect(optimized.gates).toHaveLength(1);
    expect(behaviour(optimized, 2)).toBe(behaviour(wrong, 2));
  });
});

describe('the compile pipeline', () => {
  const SPEC = { kind: 'boolean' as const, source: 'in a, b, c\nout = (a AND b) XOR c\ncarry = a AND b' };

  it('runs the optimizer as a stage and reports it alongside the checks', () => {
    const result = compile(SPEC);
    expect(result.stages.map((s) => s.stage)).toContain('optimize');
    expect(result.optimization!.discarded).toBe(0);
    expect(result.report.optimization).toBe(result.optimization);
    expect(result.report.passed).toBe(true);
  });

  it('verifies and emits the optimized circuit, not the one lowering produced', () => {
    const result = compile(SPEC);
    expect(result.circuit).not.toBe(result.unoptimized);
    expect(toffolis(result.circuit)).toBeLessThan(toffolis(result.unoptimized));
    expect(result.estimate.gateCount).toBe(result.circuit.gates.length);
    expect(depth(result.circuit)).toBe(result.estimate.depth);
  });

  it('can be switched off, and then compiles exactly what lowering produced', () => {
    const result = compile({ ...SPEC, optimize: false });
    expect(result.optimization).toBeNull();
    expect(result.report.optimization).toBeUndefined();
    expect(result.circuit).toBe(result.unoptimized);
    expect(result.report.passed).toBe(true);
  });

  it('gets the same answer either way — optimizing is not allowed to change the result', () => {
    const on = compile(SPEC);
    const off = compile({ ...SPEC, optimize: false });
    expect(behaviour(on.circuit, 3)).toBe(behaviour(off.circuit, 3));
    // The saving lands where it matters: a quarter of the T gates, measured off the
    // decomposition that was actually emitted rather than projected from a table.
    expect(on.estimate.cliffordT.source).toBe('measured');
    expect(on.estimate.cliffordT.tCount).toBe(7);
    expect(off.estimate.cliffordT.tCount).toBe(28);
  });

  it('optimizes on the estimate fast path too, so the figures match a full compile', () => {
    const fast = estimateOnly(SPEC);
    const full = compile(SPEC);
    expect(fast.optimization!.discarded).toBe(0);
    expect(fast.estimate.qubits).toBe(full.estimate.qubits);
    expect(fast.estimate.gateCount).toBe(full.estimate.gateCount);
    expect(fast.estimate.depth).toBe(full.estimate.depth);
  });
});
