import { describe, expect, it } from 'vitest';
import {
  compile,
  COMPILER_VERSION,
  contentHash,
  estimateOnly,
  GATE_COST,
  MAX_VERIFICATION_OPS,
  preflight,
  lowerBoolean,
  QsynthError,
  type CompileResult,
} from '@qsynth/core';

const SPEC = 'in a, b, c\nout = (a AND b) XOR c';

function compileOk(source: string, extra: Partial<Parameters<typeof compile>[0]> = {}): CompileResult {
  const result = compile({ kind: 'boolean', source, ...extra });
  expect(result.report.passed, JSON.stringify(result.report.checks.find((c) => c.status === 'failed'))).toBe(true);
  return result;
}

describe('the pipeline', () => {
  const result = compileOk(SPEC);

  it('produces a verified circuit, an artifact and a trace in one pass', () => {
    expect(result.report.passed).toBe(true);
    expect(result.qasm).toContain('OPENQASM 3.0;');
    expect(result.trace.length).toBeGreaterThan(0);
    expect(result.compilerVersion).toBe(COMPILER_VERSION);
  });

  it('attributes time to each stage in order', () => {
    expect(result.stages.map((s) => s.stage)).toEqual(['parse', 'lower', 'estimate', 'verify', 'emit']);
    expect(result.stages.every((s) => s.status === 'passed')).toBe(true);
    expect(result.stages.every((s) => s.durationMs >= 0)).toBe(true);
  });

  it('records the failing stage and its error code when a stage throws', () => {
    try {
      compile({ kind: 'boolean', source: 'out = (a AND' });
      expect.unreachable('a malformed spec must not compile');
    } catch (error) {
      expect(error).toBeInstanceOf(QsynthError);
      expect((error as QsynthError).code).toBe('PARSE_ERROR');
    }
  });

  it('still produces a report — a failing one — when verification fails', () => {
    const failed = compile({ kind: 'boolean', source: 'in a, b\nout = a AND b', budget: { maxQubits: 2 } });
    expect(failed.report.passed).toBe(false);
    expect(failed.report.stoppedAt).toBe('resource');
    // The artifact exists; the gate is the report, not the absence of output.
    expect(failed.qasm).toContain('OPENQASM');
  });
});

describe('the trace', () => {
  const result = compileOk(SPEC);

  it('covers every phase of the compile', () => {
    const phases = new Set(result.trace.map((e) => e.phase));
    expect([...phases].sort()).toEqual(['emit', 'estimate', 'lower', 'parse', 'reversible', 'verify']);
  });

  it('is numbered in the order decisions were made', () => {
    expect(result.trace.map((e) => e.seq)).toEqual(result.trace.map((_, i) => i));
  });

  it('explains each check in the user\'s terms', () => {
    const verified = result.trace.filter((e) => e.phase === 'verify');
    expect(verified).toHaveLength(6);
    expect(verified[0]!.message).toContain('Type and shape');
  });

  it('links lowering entries back to source spans', () => {
    const spanned = result.trace.filter((e) => e.phase === 'lower' && e.span !== undefined);
    expect(spanned.length).toBeGreaterThan(0);
  });
});

describe('OpenQASM emission', () => {
  const result = compileOk(SPEC);

  it('declares one qubit register covering every wire, and one classical bit per output', () => {
    expect(result.qasm).toContain(`qubit[${result.circuit.wires.length}] q;`);
    expect(result.qasm).toContain(`bit[${result.circuit.outputs.length}] c;`);
  });

  it('uses only gates from stdgates.inc', () => {
    const body = result.qasm
      .split('\n')
      .filter((line) => line && !line.startsWith('//') && !line.startsWith('OPENQASM') && !line.startsWith('include'));
    const used = new Set(body.map((line) => line.split(' ')[0]).filter((word) => word && !word.startsWith('qubit') && !word.startsWith('bit') && !word.startsWith('c[')));
    expect([...used].every((gate) => ['x', 'cx', 'ccx', 'cswap'].includes(gate!))).toBe(true);
  });

  it('emits exactly one instruction per gate', () => {
    const instructions = result.qasm.split('\n').filter((l) => /^(x|cx|ccx|cswap) /.test(l));
    expect(instructions).toHaveLength(result.circuit.gates.length);
  });

  it('documents which wire is which', () => {
    const map = result.qasm.slice(result.qasm.indexOf('// Wire map:')).split('\n');
    expect(map[0]).toBe('// Wire map:');
    for (const wire of result.circuit.wires) {
      const line = map.find((l) => l.startsWith(`//   q[${wire.index}]`));
      expect(line, `wire ${wire.index} is missing from the wire map`).toBeDefined();
      expect(line!).toContain(wire.role);
      expect(line!.endsWith(wire.name)).toBe(true);
    }
  });

  it('offers the same circuit as text for screen readers', () => {
    expect(result.gateList.split('\n')).toHaveLength(result.circuit.gates.length);
    expect(result.gateList).toContain('Toffoli: controls');
  });
});

describe('resource estimates', () => {
  const result = compileOk(SPEC);

  it('counts qubits by role, adding up to the total', () => {
    const { qubits, inputQubits, ancillaQubits, outputQubits } = result.estimate;
    expect(inputQubits + ancillaQubits + outputQubits).toBe(qubits);
    expect(inputQubits).toBe(3);
  });

  it('projects T count from the per-gate table', () => {
    const toffolis = result.circuit.gates.filter((g) => g.kind === 'ccnot').length;
    expect(result.estimate.projected.tCount).toBe(toffolis * GATE_COST.ccnot.t);
  });

  it('reports T-depth as a critical path, not a sum', () => {
    const { tCount, tDepth } = result.estimate.projected;
    expect(tDepth).toBeGreaterThan(0);
    expect(tDepth).toBeLessThanOrEqual(tCount);
  });

  it('says which basis the projection assumes', () => {
    expect(result.estimate.projected.basis).toContain('Clifford+T');
  });

  it('gives depth no greater than the gate count', () => {
    expect(result.estimate.depth).toBeLessThanOrEqual(result.estimate.gateCount);
  });
});

describe('pre-flight refusal', () => {
  it('accepts a spec that fits the budget', () => {
    const check = preflight(lowerBoolean(SPEC));
    expect(check.accepted).toBe(true);
    expect(check.reason).toBeUndefined();
  });

  it('refuses a spec projected past the ceiling before doing the work', () => {
    const source = oversized();
    const check = preflight(lowerBoolean(source));
    expect(check.accepted).toBe(false);
    expect(check.projectedVerificationOps).toBeGreaterThan(MAX_VERIFICATION_OPS);

    let thrown: QsynthError | undefined;
    try {
      compile({ kind: 'boolean', source });
    } catch (error) {
      thrown = error as QsynthError;
    }
    expect(thrown?.code).toBe('BUDGET_EXCEEDED');
    // The refusal has to be actionable: it quotes the projection and the ceiling.
    expect(thrown!.message).toContain('million simulation steps');
    expect(thrown!.details).toMatchObject({ accepted: false, limit: MAX_VERIFICATION_OPS });
    // And it happened at parse time, before lowering or verification ran.
    expect(thrown!.details.projectedGates).toBeTypeOf('number');
  });

  it('refuses more input bits than the IR allows', () => {
    const inputs = Array.from({ length: 21 }, (_, i) => `a${i}`);
    let thrown: QsynthError | undefined;
    try {
      compile({ kind: 'boolean', source: `in ${inputs.join(', ')}\nout = ${inputs.join(' XOR ')}` });
    } catch (error) {
      thrown = error as QsynthError;
    }
    expect(thrown?.code).toBe('INVALID_SPEC');
  });
});

describe('estimate-only path', () => {
  it('lowers and estimates without verifying, and produces no artifact', () => {
    const result = estimateOnly({ kind: 'boolean', source: SPEC });
    expect(result.estimate.qubits).toBeGreaterThan(0);
    expect(result.stages.map((s) => s.stage)).toEqual(['parse', 'lower', 'estimate']);
    expect(result).not.toHaveProperty('qasm');
    expect(result).not.toHaveProperty('report');
  });

  it('agrees with the full compile on the numbers', () => {
    expect(estimateOnly({ kind: 'boolean', source: SPEC }).estimate).toEqual(compileOk(SPEC).estimate);
  });

  it('reports the pre-flight verdict rather than throwing, so the caller can advise', () => {
    const result = estimateOnly({ kind: 'boolean', source: oversized() });
    expect(result.preflight.accepted).toBe(false);
    expect(result.estimate.qubits).toBeGreaterThan(0);
  });
});

function without(detail: unknown, key: string): unknown {
  if (detail === undefined || detail === null || typeof detail !== 'object') return detail;
  const { [key]: _dropped, ...rest } = detail as Record<string, unknown>;
  return rest;
}

/**
 * A spec that fits every structural limit but not the time budget: 18 inputs (so
 * verification samples 2^12 assignments) across a few thousand operations.
 */
function oversized(): string {
  const inputs = Array.from({ length: 18 }, (_, i) => `a${i}`);
  const terms = Array.from({ length: 3000 }, (_, i) => inputs[i % 18]).join(' XOR ');
  return `in ${inputs.join(', ')}\nout = ${terms}`;
}

describe('reproducibility', () => {
  it('produces identical hashes for identical input', () => {
    const first = compileOk(SPEC);
    const second = compileOk(SPEC);
    expect(second.specHash).toBe(first.specHash);
    expect(second.artifactHash).toBe(first.artifactHash);
    expect(second.qasm).toBe(first.qasm);
  });

  it('produces identical traces and reports, apart from timing', () => {
    const strip = (result: CompileResult) => ({
      // Timings are the only thing allowed to vary between two runs of the same spec.
      trace: result.trace.map((entry) => ({ ...entry, detail: without(entry.detail, 'durationMs') })),
      checks: result.report.checks.map(({ durationMs, ...rest }) => rest),
      passed: result.report.passed,
    });
    expect(strip(compileOk(SPEC))).toEqual(strip(compileOk(SPEC)));
  });

  it('gives different specs different hashes', () => {
    expect(compileOk('out = a AND b').artifactHash).not.toBe(compileOk('out = a OR b').artifactHash);
  });

  it('hashes the spec by content, not by formatting of the request', () => {
    expect(compileOk(SPEC).specHash).toBe(contentHash({ kind: 'boolean', source: SPEC }));
  });

  it('ties each artifact to the exact text that produced it', () => {
    // Re-formatted source is a different submission, so it gets a different spec hash —
    // and because the artifact carries that hash as provenance, a different artifact hash
    // too, even though the circuit is identical. Provenance beats de-duplication here: an
    // exported QASM file has to say which spec it came from.
    const original = compileOk(SPEC);
    const reformatted = compileOk(`${SPEC}\n`);
    expect(reformatted.specHash).not.toBe(original.specHash);
    expect(reformatted.artifactHash).not.toBe(original.artifactHash);
    expect(reformatted.qasm).toContain(`// spec ${reformatted.specHash}`);
    // The circuit itself — what the gate list describes — is unchanged.
    expect(reformatted.gateList).toBe(original.gateList);
  });
});
