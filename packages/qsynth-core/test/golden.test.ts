/**
 * Golden corpus. Three things are asserted per circuit, in increasing order of what they
 * would catch:
 *
 *   1. it verifies — all six checks pass, exhaustively where the input space allows;
 *   2. it is *right* — every input assignment agrees with the independent reference model
 *      in `corpus.ts`, simulated on the emitted circuit rather than on the IR;
 *   3. it has not changed — the QASM is snapshotted to `test/golden/<name>.qasm`.
 *
 * (3) alone would be a trap: a snapshot happily freezes a wrong answer. It is here to make
 * output changes *visible in review*, which is why the files are committed and readable
 * rather than serialised blobs. A diff in one of them must be explained in the PR.
 */
import { describe, expect, it } from 'vitest';
import { assignmentToBits, compile, outputsByName, run, initialState, type Bit } from '@qsynth/core';
import { CORPUS } from './corpus.js';

describe.each(CORPUS)('$name', (entry) => {
  const result = compile({ kind: entry.kind, source: entry.source, name: entry.name });
  const space = 2 ** entry.inputs.length;

  it('passes every check', () => {
    const failed = result.report.checks.filter((c) => c.status === 'failed');
    expect(failed.map((c) => `${c.title}: ${c.summary}`)).toEqual([]);
    expect(result.report.passed).toBe(true);
    expect(result.report.checks).toHaveLength(6);
  });

  it('skips a check only for want of something to check, never for want of a run', () => {
    // A corpus entry that declares no budget legitimately skips check 6. What must never
    // happen is a skip caused by an earlier failure — that is a short-circuit, and it
    // would mean the report is quieter than the circuit deserves.
    for (const check of result.report.checks.filter((c) => c.status === 'skipped')) {
      expect(check.summary, `${check.title} was skipped`).toMatch(/nothing to (check|enforce)/);
    }
  });

  it('is verified exhaustively', () => {
    expect(result.report.checks.find((c) => c.id === 'simulation_equivalence')!.coverage).toMatchObject({
      mode: 'exhaustive',
      checked: space,
      space,
    });
  });

  it('declares the inputs the corpus expects', () => {
    expect(result.module.inputs.map((i) => i.name)).toEqual(entry.inputs);
  });

  it('agrees with an independently written reference on every input', () => {
    for (let assignment = 0; assignment < space; assignment++) {
      const bits = assignmentToBits(assignment, entry.inputs.length);
      const state = run(result.circuit, initialState(result.circuit, bits));
      const observed = outputsByName(result.circuit, state);
      const expected = entry.reference(bits);
      const named = entry.inputs.map((name, i) => `${name}=${bits[i]}`).join(' ');
      for (const [output, value] of Object.entries(expected)) {
        expect(observed[output], `${entry.name} output "${output}" at ${named}`).toBe(value);
      }
    }
  });

  it('leaves no garbage on any input', () => {
    for (let assignment = 0; assignment < space; assignment++) {
      const bits = assignmentToBits(assignment, entry.inputs.length);
      const state = run(result.circuit, initialState(result.circuit, bits));
      expect(result.circuit.ancillas.map((a) => state[a.wire]).every((v) => v === 0)).toBe(true);
      expect(result.circuit.inputs.map((i) => state[i.wire] as Bit)).toEqual([...bits]);
    }
  });

  it('holds every declared assertion on every input', () => {
    const assertions = result.circuit.outputs.filter((o) => o.name.startsWith('assert:'));
    for (let assignment = 0; assignment < space; assignment++) {
      const bits = assignmentToBits(assignment, entry.inputs.length);
      const state = run(result.circuit, initialState(result.circuit, bits));
      for (const wire of assertions) expect(state[wire.wire], `${wire.name} at assignment ${assignment}`).toBe(1);
    }
  });

  it('matches its golden QASM', async () => {
    const header = [
      `// golden: ${entry.name} — ${entry.purpose}`,
      '//',
      '// Source specification:',
      ...entry.source.split('\n').map((line) => `//   ${line}`),
      '//',
      `// ${result.estimate.qubits} qubits (${result.estimate.inputQubits} in, ${result.estimate.ancillaQubits} ancilla, ` +
        `${result.estimate.outputQubits} out), ${result.estimate.gateCount} gates, depth ${result.estimate.depth}, ` +
        `projected T count ${result.estimate.projected.tCount}.`,
      '',
    ].join('\n');
    await expect(header + result.qasm).toMatchFileSnapshot(`./golden/${entry.name}.qasm`);
  });
});

describe('the corpus as a whole', () => {
  it('covers both frontends', () => {
    expect(new Set(CORPUS.map((c) => c.kind))).toEqual(new Set(['boolean', 'truthtable']));
  });

  it('exercises every reversible gate kind the emitter can produce', () => {
    const kinds = new Set<string>();
    for (const entry of CORPUS) {
      for (const gate of compile({ kind: entry.kind, source: entry.source }).circuit.gates) kinds.add(gate.kind);
    }
    // No `cswap`: Bennett lowering of Boolean operators never needs a controlled swap.
    // Task 5's decomposition rules and the optimizer are where Fredkin gates appear.
    expect([...kinds].sort()).toEqual(['ccnot', 'cnot', 'x']);
  });
});
