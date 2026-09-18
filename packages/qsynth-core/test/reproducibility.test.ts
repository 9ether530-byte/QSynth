/**
 * FR-7 as a test rather than a claim.
 *
 * "Reproducible" has to mean something checkable, so it is pinned down here as four
 * separate statements, each of which could fail on its own:
 *
 *   1. the same spec compiled twice gives byte-identical artifacts and equal hashes;
 *   2. the spec hash depends on the submitted text and nothing else — not on the module
 *      name, not on the order of anything, not on the clock;
 *   3. verification is deterministic, including the sampled path, because its randomness
 *      is seeded from the spec hash rather than from entropy;
 *   4. re-verifying a stored artifact reproduces the stored report.
 *
 * (3) is the one that would rot silently: swap `seedFromHash` for `Math.random()` and every
 * other test in the repo still passes while "verified with 4096 samples" stops meaning
 * anything anyone can re-run.
 */
import { describe, expect, it } from 'vitest';
import {
  compile,
  contentHash,
  estimate as estimateResources,
  lowerBoolean,
  lowerToReversible,
  lowerToQuantum,
  seedFromHash,
  TraceRecorder,
  verify,
  type CompileResult,
} from '@qsynth/core';
import { CORPUS } from './corpus.js';

/** Everything that must be identical between two compiles of the same spec. */
function fingerprint(result: CompileResult) {
  return {
    specHash: result.specHash,
    artifactHash: result.artifactHash,
    qasm: result.qasm,
    gateList: result.gateList,
    estimate: result.estimate,
    passed: result.report.passed,
    checks: result.report.checks.map(({ durationMs, ...rest }) => rest),
    trace: result.trace.map((entry) => entry.message),
  };
}

describe('compiling the corpus twice', () => {
  it.each(CORPUS)('$name is byte-identical on the second run', (entry) => {
    const first = compile({ kind: entry.kind, source: entry.source, name: entry.name });
    const second = compile({ kind: entry.kind, source: entry.source, name: entry.name });
    expect(fingerprint(second)).toEqual(fingerprint(first));
  });

  it('gives every corpus entry a distinct artifact', () => {
    const hashes = CORPUS.map((entry) => compile({ kind: entry.kind, source: entry.source, name: entry.name }).artifactHash);
    expect(new Set(hashes).size).toBe(CORPUS.length);
  });
});

describe('the spec hash', () => {
  const source = 'in a, b\nout = a AND b';

  it('is the hash of the submission, independent of what the module is called', () => {
    const named = compile({ kind: 'boolean', source, name: 'conjunction' });
    const unnamed = compile({ kind: 'boolean', source });
    expect(named.specHash).toBe(unnamed.specHash);
    expect(named.specHash).toBe(contentHash({ kind: 'boolean', source }));
    // The name does reach the artifact, though — it is written into the QASM header — so
    // the two artifacts are legitimately different files.
    expect(named.artifactHash).not.toBe(unnamed.artifactHash);
    expect(named.qasm).toContain('// conjunction —');
  });

  it('separates the two frontends even when the text is identical', () => {
    const table = 'a b | out\n0 0 | 0\n0 1 | 0\n1 0 | 0\n1 1 | 1\n';
    expect(contentHash({ kind: 'boolean', source: table })).not.toBe(contentHash({ kind: 'truthtable', source: table }));
  });

  it('is stable across releases for a fixed spec', () => {
    // Frozen deliberately. The spec hash is what users cite when they say "job X compiled
    // spec Y"; changing how it is computed invalidates every such reference, so a change
    // here must be a conscious decision and a migration, not a side effect.
    expect(contentHash({ kind: 'boolean', source: 'in a, b\nout = a AND b' })).toBe(
      '7625cad7af5a4b5b43c09700a2ad4ab3ea5cad7868f1b73eeabd7c79a4a50863',
    );
  });
});

describe('sampled verification', () => {
  // 14 inputs: above the exhaustive limit, so check 2 samples rather than enumerates.
  const source = `in ${Array.from({ length: 14 }, (_, i) => `b${i}`).join(', ')}\nparity = ${Array.from(
    { length: 14 },
    (_, i) => `b${i}`,
  ).join(' XOR ')}`;

  const coverageOf = (result: CompileResult) =>
    result.report.checks.find((c) => c.id === 'simulation_equivalence')!.coverage!;

  it('says plainly that it sampled, and how much of the space it saw', () => {
    const coverage = coverageOf(compile({ kind: 'boolean', source }));
    expect(coverage.mode).toBe('sampled');
    expect(coverage.space).toBe(2 ** 14);
    expect(coverage.checked).toBe(4096);
    expect(coverage.checked).toBeLessThan(coverage.space);
  });

  it('draws the same sample every time, from a seed anyone can recompute', () => {
    const first = compile({ kind: 'boolean', source });
    const second = compile({ kind: 'boolean', source });
    expect(coverageOf(second).seed).toBe(coverageOf(first).seed);
    // Not "some seed we happened to store" — the seed is a function of the spec hash, so a
    // third party holding only the spec can reproduce the exact sample.
    expect(coverageOf(first).seed).toBe(seedFromHash(first.specHash));
  });

  it('honours an explicit sample count, and records the count it actually used', () => {
    const coverage = coverageOf(compile({ kind: 'boolean', source, sampleCount: 500 }));
    expect(coverage.checked).toBe(500);
  });
});

describe('re-verification of a stored artifact', () => {
  it('reproduces the report the compile produced', () => {
    const entry = CORPUS[2]!;
    const original = compile({ kind: entry.kind, source: entry.source, name: entry.name });

    // What `POST /v1/compile/{id}/verify` does: rebuild from the stored spec and re-run the
    // checks. The verdict must not depend on anything that lived only in the first request.
    const trace = new TraceRecorder();
    const module = lowerBoolean(entry.source, { moduleName: entry.name, trace });
    const { circuit } = lowerToReversible(module, trace);
    const quantum = lowerToQuantum(circuit, trace);
    const report = verify(module, circuit, estimateResources(circuit, quantum), {
      compilerVersion: original.compilerVersion,
      specHash: original.specHash,
      seed: seedFromHash(original.specHash),
      quantum,
    });

    expect(report.passed).toBe(original.report.passed);
    expect(report.checks.map((c) => [c.id, c.status, c.summary])).toEqual(
      original.report.checks.map((c) => [c.id, c.status, c.summary]),
    );
  });
});
