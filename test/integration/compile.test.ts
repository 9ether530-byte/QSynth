/**
 * The compile surface, end to end over the network.
 *
 * The unit suite already proves the compiler is correct. What can only be proven here is
 * that the *deployment* keeps its promises: that a refusal happens before the work, that
 * a failed verification cannot be mistaken for a success by an HTTP client, and — the one
 * that matters most — that the export gate lives in the server and not in the interface.
 *
 * Every assertion about the gate is written against `curl`-equivalent calls for that
 * reason. A gate that only holds in the workbench is not a gate.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { call, createTenant, errorCode, unique, type Tenant } from './client.js';

const HALF_ADDER = 'in a, b\nsum = a XOR b\ncarry = a AND b\n';

/** Fits every structural limit, but not the verification time budget. */
const OVERSIZED = (() => {
  const inputs = Array.from({ length: 18 }, (_, i) => `a${i}`);
  const terms = Array.from({ length: 3000 }, (_, i) => inputs[i % 18]).join(' XOR ');
  return `in ${inputs.join(', ')}\nout = ${terms}`;
})();

let org: Tenant;
let projectId: string;
let passingJob: { id: string; artifacts: { id: string; kind: string; contentHash: string }[] };

beforeAll(async () => {
  org = await createTenant('compile');
  const project = await call('POST', '/v1/projects', {
    auth: { token: org.token },
    body: { name: 'Compile fixtures' },
  });
  expect(project.status, JSON.stringify(project.body)).toBe(201);
  projectId = project.body.project.id;

  const res = await call('POST', '/v1/compile', {
    auth: { token: org.token },
    body: { projectId, kind: 'boolean', source: HALF_ADDER, name: 'half_adder' },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  passingJob = { id: res.body.job.id, artifacts: res.body.artifacts };
});

describe('a specification that verifies', () => {
  it('reports six checks, all of them reached and passed', async () => {
    const res = await call('GET', `/v1/compile/${passingJob.id}`, { auth: { token: org.token } });
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('succeeded');
    expect(res.body.verification.passed).toBe(true);
    expect(res.body.verification.checks).toHaveLength(6);
    expect(res.body.verification.stoppedAt).toBeNull();
  });

  it('says exhaustively how much of the input space it checked', async () => {
    const res = await call('GET', `/v1/compile/${passingJob.id}`, { auth: { token: org.token } });
    const equivalence = res.body.verification.checks.find((c: { id: string }) => c.id === 'simulation_equivalence');
    expect(equivalence.coverage.mode).toBe('exhaustive');
    expect(equivalence.coverage.checked).toBe(4); // two inputs
    expect(equivalence.coverage.space).toBe(4);
    expect(res.body.verification.method).toBe('exhaustive');
  });

  it('attributes time to each pipeline stage rather than to the request as a whole', async () => {
    const res = await call('GET', `/v1/compile/${passingJob.id}`, { auth: { token: org.token } });
    expect(res.body.stages.map((s: { stage: string }) => s.stage)).toEqual(['parse', 'lower', 'decompose', 'estimate', 'verify', 'emit']);
    for (const stage of res.body.stages) expect(stage.status).toBe('ok');
  });

  it('keeps the reversible-layer figures apart from the Clifford+T ones, and says which were counted', async () => {
    const res = await call('GET', `/v1/compile/${passingJob.id}`, { auth: { token: org.token } });
    expect(res.body.resources.measured.qubits).toBeGreaterThan(0);
    expect(res.body.resources.cliffordT.tCount).toBeGreaterThan(0);
    expect(res.body.resources.measured).not.toHaveProperty('tCount');
    expect(res.body.resources.cliffordT).not.toHaveProperty('qubits');
    // A full compile decomposes before estimating, so these are counted off the circuit
    // that was emitted — not read off the per-gate table.
    expect(res.body.resources.cliffordT.source).toBe('measured');
  });

  it('stores both IR layers, the QASM and the trace as separate artifacts', async () => {
    const kinds = passingJob.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['qasm3', 'quantum_ir', 'reversible_ir', 'trace']);
  });
});

describe('the export gate', () => {
  it('releases an artifact whose job passed, naming the job that vouches for it', async () => {
    const artifact = passingJob.artifacts.find((a) => a.kind === 'qasm3')!;
    const res = await call('GET', `/v1/artifacts/${artifact.id}`, { auth: { token: org.token } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.content).toContain('OPENQASM 3.0;');
    expect(res.body.verifiedBy.jobId).toBe(passingJob.id);
    expect(res.body.artifact.contentHash).toBe(artifact.contentHash);
  });

  it('refuses an artifact from a job that failed verification — over HTTP, not in the UI', async () => {
    // A budget too small for the circuit: check 6 fails, so nothing may be exported.
    const compile = await call('POST', '/v1/compile', {
      auth: { token: org.token },
      body: { projectId, kind: 'boolean', source: HALF_ADDER, name: 'budgeted', budget: { maxQubits: 2 } },
    });
    expect(compile.status, JSON.stringify(compile.body)).toBe(422);
    expect(errorCode(compile)).toBe('VERIFICATION_FAILED');
    expect(compile.body.error.details.check.id).toBe('resource');

    const jobId = compile.body.error.details.jobId;
    const job = await call('GET', `/v1/compile/${jobId}`, { auth: { token: org.token } });
    expect(job.body.job.status).toBe('failed');
    expect(job.body.verification.passed).toBe(false);
    expect(job.body.verification.stoppedAt).toBe('resource');
    expect(job.body.artifacts.length).toBeGreaterThan(0);

    for (const artifact of job.body.artifacts) {
      const res = await call('GET', `/v1/artifacts/${artifact.id}`, { auth: { token: org.token } });
      expect(res.status, `${artifact.kind} was released`).toBe(403);
      expect(errorCode(res)).toBe('VERIFICATION_REQUIRED');
      expect(res.body).not.toHaveProperty('content');
    }
  });

  it('does not return the QASM inline when verification failed', async () => {
    const compile = await call('POST', '/v1/compile', {
      auth: { token: org.token },
      body: { projectId, kind: 'boolean', source: 'in a, b, c\nout = (a AND b) XOR c', budget: { maxTCount: 1 } },
    });
    expect(compile.status).toBe(422);
    expect(JSON.stringify(compile.body)).not.toContain('OPENQASM');
  });
});

describe('refusing before accepting', () => {
  it('rejects a specification projected to exceed the verification budget', async () => {
    const res = await call('POST', '/v1/compile', {
      auth: { token: org.token },
      body: { projectId, kind: 'boolean', source: OVERSIZED, name: 'oversized' },
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(422);
    expect(errorCode(res)).toBe('BUDGET_EXCEEDED');

    const { preflight } = res.body.error.details;
    expect(preflight.accepted).toBe(false);
    expect(preflight.projectedVerificationOps).toBeGreaterThan(preflight.limit);
    // The refusal names the figures, so the user knows what to change.
    expect(res.body.error.message).toMatch(/million simulation steps/);
  });

  it('records the refusal as a job rather than losing it', async () => {
    const res = await call('GET', `/v1/compile?projectId=${projectId}`, { auth: { token: org.token } });
    const rejected = res.body.jobs.filter((j: { status: string }) => j.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0].errorCode).toBe('BUDGET_EXCEEDED');
  });

  it('answers a syntax error with the span, and creates no job for it', async () => {
    const before = await call('GET', `/v1/compile?projectId=${projectId}`, { auth: { token: org.token } });
    const res = await call('POST', '/v1/compile', {
      auth: { token: org.token },
      body: { projectId, kind: 'boolean', source: 'in a, b\nout = a AND' },
    });
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe('PARSE_ERROR');
    expect(res.body.error.details.span.line).toBe(2);
    expect(res.body.error.hint.length).toBeGreaterThan(0);

    const after = await call('GET', `/v1/compile?projectId=${projectId}`, { auth: { token: org.token } });
    expect(after.body.jobs).toHaveLength(before.body.jobs.length);
  });
});

describe('the estimate fast path', () => {
  it('reports resources without verifying, and says so', async () => {
    const res = await call('POST', '/v1/compile/estimate', {
      auth: { token: org.token },
      body: { kind: 'boolean', source: HALF_ADDER },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.resources.measured.qubits).toBeGreaterThan(0);
    expect(res.body).not.toHaveProperty('artifacts');
    expect(res.body).not.toHaveProperty('qasm');
    // This path stops before decomposing, so its Clifford+T figures are read off the
    // per-gate table and have to say so — a T count the caller cannot reproduce from an
    // artifact must not be presented as if it had been counted.
    expect(res.body.resources.cliffordT.source).toBe('projected');
  });

  it('persists nothing — an unverified circuit leaves no artifact behind', async () => {
    const before = await call('GET', `/v1/compile?projectId=${projectId}`, { auth: { token: org.token } });
    await call('POST', '/v1/compile/estimate', {
      auth: { token: org.token },
      body: { kind: 'boolean', source: 'in x, y\nout = x OR y' },
    });
    const after = await call('GET', `/v1/compile?projectId=${projectId}`, { auth: { token: org.token } });
    expect(after.body.jobs).toHaveLength(before.body.jobs.length);
  });

  it('still refuses a specification that is too large to verify', async () => {
    const res = await call('POST', '/v1/compile/estimate', {
      auth: { token: org.token },
      body: { kind: 'boolean', source: OVERSIZED },
    });
    // The estimate itself is cheap, so it succeeds — but it must say the compile would
    // be refused, rather than quoting resources for something that can never be built.
    expect(res.status).toBe(200);
    expect(res.body.preflight.accepted).toBe(false);
  });
});

describe('reproducibility over the wire', () => {
  it('gives the same artifact hashes when the same specification is compiled twice', async () => {
    const second = await call('POST', '/v1/compile', {
      auth: { token: org.token },
      body: { projectId, kind: 'boolean', source: HALF_ADDER, name: 'half_adder' },
    });
    expect(second.status).toBe(201);
    expect(second.body.specHash).toBeDefined();

    const first = await call('GET', `/v1/compile/${passingJob.id}`, { auth: { token: org.token } });
    expect(second.body.job.specHash).toBe(first.body.job.specHash);
    // Same spec, same bytes: the artifact rows are reused rather than duplicated.
    expect(second.body.artifacts.map((a: { id: string }) => a.id).sort()).toEqual(
      passingJob.artifacts.map((a) => a.id).sort(),
    );
    // But it is a new run of the same spec, so the version chain advances.
    expect(second.body.version.number).toBeGreaterThan(1);
  });

  it('re-verifies a stored job and reproduces its report', async () => {
    const res = await call('POST', `/v1/compile/${passingJob.id}/verify`, { auth: { token: org.token } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reproduced).toBe(true);
    expect(res.body.storedPassed).toBe(true);
    expect(res.body.divergence).toEqual([]);
    expect(res.body.compilerVersion).toBe(res.body.storedCompilerVersion);
  });

  it('replays an idempotent compile instead of running it twice', async () => {
    const key = unique('compile-idem');
    const body = { projectId, kind: 'boolean', source: 'in p, q\nout = p NAND q', name: 'nand' };

    const first = await call('POST', '/v1/compile', { auth: { token: org.token, idempotencyKey: key }, body });
    expect(first.status).toBe(201);
    const second = await call('POST', '/v1/compile', { auth: { token: org.token, idempotencyKey: key }, body });
    expect(second.status).toBe(201);
    expect(second.body.job.id).toBe(first.body.job.id);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
  });
});

describe('truth tables', () => {
  it('compiles and verifies a table, reporting its don\'t-care rows rather than filling them', async () => {
    const res = await call('POST', '/v1/compile', {
      auth: { token: org.token },
      body: {
        projectId,
        kind: 'truthtable',
        name: 'partial',
        source: 'a b | out\n0 0 | 0\n0 1 | 1\n1 0 | -\n',
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const equivalence = res.body.verification.checks.find((c: { id: string }) => c.id === 'simulation_equivalence');
    expect(equivalence.coverage.dontCare).toBeGreaterThan(0);
    expect(equivalence.coverage.checked).toBeLessThan(equivalence.coverage.space);
  });
});
