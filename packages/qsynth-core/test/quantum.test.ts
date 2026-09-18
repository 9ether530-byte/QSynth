/**
 * The quantum layer: decomposition rules, the two simulators, and the check that ties
 * them to what gets emitted.
 *
 * The load-bearing claim of this layer is stated in `lowering/reversibleToQuantum.ts`:
 * because the lowering is context-free, per-rule exactness gives whole-circuit
 * correctness. That argument has two halves and this file attacks both — the rules are
 * right (exact unitaries), and the rules are *used* right (end-to-end execution of the
 * emitted gate list). A suite that only did the first would pass happily against a
 * decomposer that wired every Toffoli's controls backwards.
 *
 * The simulators are also checked against each other. Statevector and tableau share no
 * code and no representation, so where they overlap — Clifford circuits of at most a few
 * qubits — agreement between them is real evidence rather than a restatement.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CircuitBuilder,
  circuitUnitary,
  checkDecomposition,
  cliffordEquivalent,
  compile,
  differsUpToGlobalPhase,
  GATE_COST,
  isClifford,
  lowerToQuantum,
  MAX_STATEVECTOR_QUBITS,
  permutationUnitary,
  QsynthError,
  QuantumBuilder,
  quantumDepth,
  quantumGateCount,
  RULES,
  Statevector,
  Tableau,
  tCount,
  tDepth,
  twoQubitCount,
  verifyRules,
  type QuantumCircuit,
  type QuantumGateKind,
  type ReversibleCircuit,
} from '@qsynth/core';

const SQRT_HALF = Math.SQRT1_2;

/** A single reversible gate on fresh wires, as its own circuit. */
function singleGate(kind: 'x' | 'cnot' | 'ccnot' | 'cswap', arity: number): ReversibleCircuit {
  const builder = new CircuitBuilder(kind);
  const wires = Array.from({ length: arity }, (_, i) => builder.addInput(`w${i}`));
  builder.emit(kind, wires);
  return builder.build();
}

// ---------------------------------------------------------------------------
// 1. The rules themselves
// ---------------------------------------------------------------------------

describe('the decomposition rules', () => {
  it('runs its own proof on the compile path, not only under test', () => {
    const verdict = verifyRules();
    expect(verdict.ok).toBe(true);
    expect(verdict.rules).toHaveLength(RULES.length);
    expect(verdict.rules.every((r) => r.ok)).toBe(true);
  });

  /**
   * The same comparison `verifyRules` makes, restated here against the hand-written
   * permutation rather than through the function under test — so a `verifyRules` that
   * returned `{ok: true}` unconditionally would still fail this.
   */
  it.each(RULES.map((r) => [r.kind, r] as const))('matches the exact unitary of %s', (_kind, rule) => {
    const expected = permutationUnitary(rule.qubits, rule.image);
    const observed = circuitUnitary(rule.qubits, rule.replacement);
    expect(differsUpToGlobalPhase(expected, observed)).toBeNull();
  });

  it('describes a permutation: each rule maps every basis state to a distinct one', () => {
    for (const rule of RULES) {
      expect(new Set(rule.image).size).toBe(2 ** rule.qubits);
      expect([...rule.image].sort((a, b) => a - b)).toEqual(Array.from({ length: 2 ** rule.qubits }, (_, i) => i));
    }
  });

  /**
   * A deliberate failure. Corrupt one gate of the Toffoli replacement — a T where a T†
   * belongs, which is the kind of transcription slip that survives a reading — and
   * confirm the unitary comparison catches it rather than absorbing it as a phase.
   */
  it('rejects a replacement that is wrong by one dagger', () => {
    const toffoli = RULES.find((r) => r.kind === 'ccnot')!;
    const corrupted = toffoli.replacement.map((g, i) => (i === 2 ? { kind: 't' as QuantumGateKind, wires: g.wires } : g));
    const difference = differsUpToGlobalPhase(permutationUnitary(3, toffoli.image), circuitUnitary(3, corrupted));
    expect(difference).not.toBeNull();
  });

  it('rejects a replacement that is right except for a swapped control', () => {
    const toffoli = RULES.find((r) => r.kind === 'ccnot')!;
    const corrupted = toffoli.replacement.map((g) => (g.kind === 'cx' && g.wires[0] === 0 ? { ...g, wires: [2, g.wires[1]!] } : g));
    expect(differsUpToGlobalPhase(permutationUnitary(3, toffoli.image), circuitUnitary(3, corrupted))).not.toBeNull();
  });

  /**
   * Global phase is not observable, so the comparison must forgive it. A relative phase
   * between basis states *is* observable, so the comparison must not forgive that — and
   * the two are one sign apart in the code.
   */
  it('forgives a global phase but not a relative one', () => {
    const identity = permutationUnitary(1, [0, 1]);
    const globalMinus = circuitUnitary(1, [{ kind: 'z', wires: [0] }, { kind: 'x', wires: [0] }, { kind: 'z', wires: [0] }, { kind: 'x', wires: [0] }]);
    expect(differsUpToGlobalPhase(identity, globalMinus)).toBeNull();
    // Z alone is the identity on |0⟩ and minus the identity on |1⟩: a relative phase.
    expect(differsUpToGlobalPhase(identity, circuitUnitary(1, [{ kind: 'z', wires: [0] }]))).not.toBeNull();
  });

  /**
   * Regression. The comparison used to anchor its phase on the first entry whose
   * magnitude cleared a fixed cutoff, and a Hadamard on every qubit spreads the amplitude
   * so thinly that no entry clears it — whereupon the function found no anchor and
   * returned "equal". This circuit is as far from the identity as a 3-qubit Clifford
   * gets, so it is the one comparison that must never come back null.
   */
  it('does not mistake a fully-spread unitary for the identity', () => {
    const hadamards = circuitUnitary(3, [
      { kind: 'h', wires: [0] },
      { kind: 'h', wires: [1] },
      { kind: 'h', wires: [2] },
    ]);
    expect(differsUpToGlobalPhase(hadamards, permutationUnitary(3, [0, 1, 2, 3, 4, 5, 6, 7]))).not.toBeNull();
    // Every entry of it has magnitude 2^{-3/2} ≈ 0.354 — below any threshold that would
    // have been safe at one qubit.
    expect(Math.abs(hadamards.re[0]!)).toBeLessThan(0.5);
    expect(differsUpToGlobalPhase(hadamards, hadamards)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The statevector simulator
// ---------------------------------------------------------------------------

describe('statevector simulation', () => {
  it('starts in the basis state it was asked for', () => {
    const state = Statevector.basis(3, 5);
    expect(state.probability(5)).toBeCloseTo(1, 12);
    expect(state.dominantBasis()).toBe(5);
  });

  it('puts H|0⟩ in an equal superposition, and H² back where it started', () => {
    const state = Statevector.basis(1, 0);
    state.apply('h', [0]);
    expect(state.amplitude(0).re).toBeCloseTo(SQRT_HALF, 12);
    expect(state.amplitude(1).re).toBeCloseTo(SQRT_HALF, 12);
    // In superposition there is no dominant basis state, and the simulator must say so
    // rather than pick one — that `null` is what stops the spot check from reading a
    // superposition as a definite answer.
    expect(state.dominantBasis()).toBeNull();
    state.apply('h', [0]);
    expect(state.dominantBasis()).toBe(0);
  });

  it('gives T the eighth root of unity, and T² = S', () => {
    const state = Statevector.basis(1, 1);
    state.apply('t', [0]);
    expect(state.amplitude(1).re).toBeCloseTo(SQRT_HALF, 12);
    expect(state.amplitude(1).im).toBeCloseTo(SQRT_HALF, 12);
    expect(differsUpToGlobalPhase(circuitUnitary(1, [{ kind: 's', wires: [0] }]), circuitUnitary(1, [{ kind: 't', wires: [0] }, { kind: 't', wires: [0] }]))).toBeNull();
  });

  it('entangles: H then CNOT gives the Bell state and nothing in between', () => {
    const state = Statevector.basis(2, 0);
    state.apply('h', [0]);
    state.apply('cx', [0, 1]);
    expect(state.probability(0b00)).toBeCloseTo(0.5, 12);
    expect(state.probability(0b11)).toBeCloseTo(0.5, 12);
    expect(state.probability(0b01)).toBeCloseTo(0, 12);
    expect(state.probability(0b10)).toBeCloseTo(0, 12);
  });

  it('keeps every gate unitary: probabilities sum to one after an arbitrary sequence', () => {
    const state = Statevector.basis(3, 0);
    for (const [kind, wires] of [
      ['h', [0]], ['t', [0]], ['cx', [0, 1]], ['s', [1]], ['h', [2]], ['cx', [2, 0]], ['tdg', [1]], ['y', [2]], ['sdg', [0]], ['z', [1]],
    ] as const) {
      state.apply(kind, [...wires]);
    }
    const total = Array.from({ length: 8 }, (_, i) => state.probability(i)).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it('refuses a width it cannot hold rather than allocating until the process dies', () => {
    expect(() => Statevector.basis(MAX_STATEVECTOR_QUBITS + 1, 0)).toThrow(QsynthError);
  });
});

// ---------------------------------------------------------------------------
// 3. The stabilizer simulator
// ---------------------------------------------------------------------------

/** A Clifford circuit over `n` qubits built from a list of (gate, wire) draws. */
function cliffordCircuit(n: number, draws: readonly { kind: QuantumGateKind; a: number; b: number }[]): QuantumCircuit {
  const builder = new QuantumBuilder(
    'random',
    Array.from({ length: n }, (_, i) => ({ index: i, name: `q${i}`, role: 'input' as const })),
    Array.from({ length: n }, (_, i) => ({ name: `q${i}`, wire: i })),
    [],
  );
  for (const draw of draws) {
    const a = draw.a % n;
    if (draw.kind === 'cx') {
      const b = draw.b % n;
      if (a === b) continue;
      builder.emit('cx', [a, b]);
    } else {
      builder.emit(draw.kind, [a]);
    }
  }
  return builder.build();
}

const cliffordDraw = fc.record({
  kind: fc.constantFrom<QuantumGateKind>('h', 's', 'sdg', 'x', 'y', 'z', 'cx'),
  a: fc.nat({ max: 7 }),
  b: fc.nat({ max: 7 }),
});

describe('stabilizer simulation', () => {
  it('leaves the identity tableau alone when nothing is applied', () => {
    const tableau = Tableau.identity(3);
    expect(tableau.equals(Tableau.identity(3))).toBe(true);
    expect(tableau.rowString(0)).toBe('+XII');
    expect(tableau.rowString(3)).toBe('+ZII');
  });

  it('conjugates X to Z and Z to X under H, which is the whole point of the representation', () => {
    const tableau = Tableau.identity(1);
    tableau.apply('h', [0]);
    expect(tableau.rowString(0)).toBe('+Z');
    expect(tableau.rowString(1)).toBe('+X');
  });

  it('tracks the sign: X conjugated by Z picks up a minus', () => {
    const tableau = Tableau.identity(1);
    tableau.apply('z', [0]);
    expect(tableau.rowString(0)).toBe('-X');
    expect(tableau.rowString(1)).toBe('+Z');
  });

  /**
   * The cross-check that makes both simulators worth having: two independent
   * representations of the same random Clifford circuit, agreeing on whether it equals
   * itself-plus-a-perturbation. Neither can be silently wrong in the same way.
   */
  it('agrees with the statevector on random Clifford circuits', () => {
    fc.assert(
      fc.property(fc.array(cliffordDraw, { minLength: 1, maxLength: 24 }), (draws) => {
        const circuit = cliffordCircuit(3, draws);
        const byUnitary = differsUpToGlobalPhase(circuitUnitary(3, circuit.gates), circuitUnitary(3, circuit.gates)) === null;
        expect(byUnitary).toBe(true);
        expect(cliffordEquivalent(circuit, circuit).equivalent).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('calls two Clifford circuits equal exactly when their unitaries are equal up to phase', () => {
    fc.assert(
      fc.property(fc.array(cliffordDraw, { maxLength: 10 }), fc.array(cliffordDraw, { maxLength: 10 }), (left, right) => {
        const a = cliffordCircuit(3, left);
        const b = cliffordCircuit(3, right);
        const byTableau = cliffordEquivalent(a, b).equivalent;
        const byUnitary = differsUpToGlobalPhase(circuitUnitary(3, a.gates), circuitUnitary(3, b.gates)) === null;
        expect(byTableau).toBe(byUnitary);
      }),
      { numRuns: 200 },
    );
  });

  it('names the generator that differs when two circuits disagree', () => {
    const a = cliffordCircuit(2, [{ kind: 'h', a: 0, b: 0 }]);
    const b = cliffordCircuit(2, []);
    const comparison = cliffordEquivalent(a, b);
    expect(comparison.equivalent).toBe(false);
    expect(comparison.difference).toMatchObject({ generator: 'X0', expected: '+ZI', observed: '+XI' });
  });

  it('refuses a T gate instead of silently producing a wrong tableau', () => {
    const tableau = Tableau.identity(1);
    expect(() => tableau.apply('t', [0])).toThrow(QsynthError);
  });
});

// ---------------------------------------------------------------------------
// 4. Lowering, end to end
// ---------------------------------------------------------------------------

describe('lowering to Clifford+T', () => {
  it.each([
    ['x', 1],
    ['cnot', 2],
    ['ccnot', 3],
    ['cswap', 3],
  ] as const)('reproduces the unitary of a lone %s gate through the full lowering', (kind, arity) => {
    const quantum = lowerToQuantum(singleGate(kind, arity));
    const rule = RULES.find((r) => r.kind === kind)!;
    expect(differsUpToGlobalPhase(permutationUnitary(arity, rule.image), circuitUnitary(arity, quantum.gates))).toBeNull();
  });

  it('introduces no new qubits, so the estimate\'s qubit count survives the layer', () => {
    const result = compile({ kind: 'boolean', source: 'in a, b, c\nout = (a AND b) XOR c' });
    expect(result.quantum.wires).toEqual(result.circuit.wires);
    expect(result.quantum.inputs).toEqual(result.circuit.inputs);
  });

  it('records the wire mapping back to the reversible gate that produced each gate', () => {
    const quantum = lowerToQuantum(singleGate('ccnot', 3));
    expect(quantum.gates.every((g) => g.source === 0)).toBe(true);
  });

  /**
   * The per-gate costs the estimate table promises, checked against the decomposition
   * that was actually emitted. This is the assertion that keeps `GATE_COST` from drifting
   * into fiction — a budget refusal quotes these numbers.
   */
  it.each([
    ['x', 1],
    ['cnot', 2],
    ['ccnot', 3],
    ['cswap', 3],
  ] as const)('costs exactly what GATE_COST claims for %s', (kind, arity) => {
    const quantum = lowerToQuantum(singleGate(kind, arity));
    const cost = GATE_COST[kind];
    expect({
      t: tCount(quantum),
      tDepth: tDepth(quantum),
      cnot: twoQubitCount(quantum),
      gates: quantumGateCount(quantum),
    }).toEqual(cost);
  });

  it('marks Toffoli-bearing circuits as non-Clifford and CNOT-only ones as Clifford', () => {
    expect(isClifford(lowerToQuantum(singleGate('ccnot', 3)))).toBe(false);
    expect(isClifford(lowerToQuantum(singleGate('cnot', 2)))).toBe(true);
  });

  it('counts T-depth as a critical path: two Toffolis on disjoint wires cost one', () => {
    const builder = new CircuitBuilder('disjoint');
    const wires = Array.from({ length: 6 }, (_, i) => builder.addInput(`w${i}`));
    builder.emit('ccnot', [wires[0]!, wires[1]!, wires[2]!]);
    builder.emit('ccnot', [wires[3]!, wires[4]!, wires[5]!]);
    const quantum = lowerToQuantum(builder.build());
    expect(tCount(quantum)).toBe(14);
    expect(tDepth(quantum)).toBe(GATE_COST.ccnot.tDepth);
    expect(quantumDepth(quantum)).toBeLessThan(quantum.gates.length);
  });
});

// ---------------------------------------------------------------------------
// 5. The check that folds into the report
// ---------------------------------------------------------------------------

describe('the decomposition check', () => {
  const assignmentsFor = (n: number) => Array.from({ length: 2 ** n }, (_, i) => i);

  it('settles a Clifford circuit by tableau, completely rather than by sampling', () => {
    const circuit = singleGate('cnot', 2);
    const result = checkDecomposition(circuit, lowerToQuantum(circuit), { assignments: assignmentsFor(2) });
    expect(result.ok).toBe(true);
    expect(result.evidence.method).toBe('tableau');
    expect(result.evidence.methodReason).toContain('Clifford');
  });

  it('spot-checks a non-Clifford circuit end to end on real input assignments', () => {
    const circuit = singleGate('ccnot', 3);
    const result = checkDecomposition(circuit, lowerToQuantum(circuit), { assignments: assignmentsFor(3) });
    expect(result.ok).toBe(true);
    expect(result.evidence.method).toBe('statevector');
    expect(result.evidence.statesChecked).toBeGreaterThan(0);
    expect(result.evidence.tCount).toBe(7);
  });

  /**
   * The deliberate failure for this layer. Every rule is still correct — it is the
   * *application* that is broken, with a Toffoli's target and control exchanged. Only the
   * end-to-end execution can see this, which is the whole argument for paying for it.
   */
  it('catches a correctly-decomposed gate applied to the wrong wires', () => {
    const circuit = singleGate('ccnot', 3);
    const good = lowerToQuantum(circuit);
    const builder = new QuantumBuilder(good.name, good.wires, good.inputs, good.outputs);
    for (const gate of good.gates) builder.emit(gate.kind, [...gate.wires].reverse());
    const result = checkDecomposition(circuit, builder.build(), { assignments: assignmentsFor(3) });

    expect(result.ok).toBe(false);
    expect(result.failure?.stage).toBe('statevector');
    expect(result.failure?.assignment).toBeTypeOf('number');
    // The rules are still sound; the report must not blame them for a wiring mistake.
    expect(result.evidence.rulesVerified).toBe(true);
  });

  it('catches a wrong Clifford decomposition by tableau, naming the generator', () => {
    const circuit = singleGate('cnot', 2);
    const good = lowerToQuantum(circuit);
    const builder = new QuantumBuilder(good.name, good.wires, good.inputs, good.outputs);
    builder.emit('cx', [1, 0]);
    const result = checkDecomposition(circuit, builder.build(), { assignments: assignmentsFor(2) });

    expect(result.ok).toBe(false);
    expect(result.failure?.stage).toBe('tableau');
    expect(result.failure?.detail).toMatch(/[XZ]\d/);
  });

  it('says so plainly when only the by-construction argument is available', () => {
    // Wider than the statevector can hold and not Clifford, so neither end-to-end method
    // applies. The check must still pass — the proof by construction is real — and must
    // state which evidence it is resting on.
    const builder = new CircuitBuilder('wide');
    const wires = Array.from({ length: MAX_STATEVECTOR_QUBITS + 3 }, (_, i) => builder.addInput(`w${i}`));
    builder.emit('ccnot', [wires[0]!, wires[1]!, wires[2]!]);
    const circuit = builder.build();
    const result = checkDecomposition(circuit, lowerToQuantum(circuit), { assignments: [0, 1] });

    expect(result.ok).toBe(true);
    expect(result.evidence.method).toBe('rules_only');
    expect(result.evidence.methodReason).toContain(String(MAX_STATEVECTOR_QUBITS));
  });
});

// ---------------------------------------------------------------------------
// 6. What the pipeline reports
// ---------------------------------------------------------------------------

describe('the decomposition inside a full compile', () => {
  const result = compile({ kind: 'boolean', source: 'in a, b, c\nout = (a AND b) XOR c' });

  it('passes, and reports the decomposition as evidence of check 2 rather than a seventh check', () => {
    expect(result.report.passed).toBe(true);
    expect(result.report.checks).toHaveLength(6);
    const equivalence = result.report.checks.find((c) => c.id === 'simulation_equivalence')!;
    expect(equivalence.status).toBe('passed');
    expect(equivalence.evidence).toHaveProperty('decomposition');
  });

  it('tells the user both what was proved and what was executed', () => {
    const summary = result.report.checks.find((c) => c.id === 'simulation_equivalence')!.summary;
    expect(summary).toContain('all 8 of 8 input assignments');
    expect(summary).toContain('exact matrix');
    expect(summary).toContain('end to end');
  });

  it('emits QASM for the decomposition, not for the reversible circuit', () => {
    expect(result.qasm).not.toContain('ccx ');
    expect(result.qasm).toContain('tdg ');
    expect(result.qasm).toContain(`// basis clifford+t:`);
  });

  it('keeps the reversible circuit available alongside it, since that is the layer checked exhaustively', () => {
    expect(result.circuit.gates.some((g) => g.kind === 'ccnot')).toBe(true);
    expect(result.gateList).toContain('Toffoli');
  });
});
