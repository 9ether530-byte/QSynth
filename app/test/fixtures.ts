/**
 * One compiled circuit, small enough to reason about and complete enough to exercise every
 * panel: two inputs, one ancilla that is uncomputed, a Toffoli, and a full six-check
 * report.
 *
 * The shapes here are transcribed from real API responses rather than invented, so a test
 * that passes against them is testing the interface against the contract and not against a
 * convenient fiction.
 */
import type {
  ApiKey,
  AuditPage,
  CompileDetail,
  JobSummary,
  Member,
  Principal,
  Project,
  ReversibleCircuit,
  TraceEntry,
  VerificationView,
} from '../src/lib/types';

export const principal: Principal = {
  principal: 'session',
  user: { id: 'u1', email: 'eng@example.com', name: 'Engineer' },
  activeOrganization: { id: 'o1', role: 'owner' },
  organizations: [{ id: 'o1', name: 'Acme Quantum', slug: 'acme', role: 'owner' }],
  permissions: [
    'project:read',
    'project:write',
    'project:delete',
    'compile:run',
    'compile:read',
    'artifact:read',
    'member:read',
    'member:write',
    'apikey:read',
    'apikey:write',
    'audit:read',
    'org:write',
  ],
};

export const project: Project = {
  id: 'p1',
  name: 'Oracles',
  description: 'Grover oracles for the search prototype',
  createdBy: 'u1',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z',
  archived: false,
};

export const jobSummary: JobSummary = {
  id: 'j1',
  projectId: 'p1',
  specId: 's1',
  specHash: 'a1b2c3d4e5f6a7b8',
  status: 'succeeded',
  compilerVersion: '1.0.0',
  errorCode: null,
  errorMessage: null,
  startedAt: '2026-09-10T10:00:00.000Z',
  finishedAt: '2026-09-10T10:00:01.000Z',
  passed: true,
};

export const verification: VerificationView = {
  passed: true,
  checks: [
    { id: 'type_shape', title: 'Type and shape', status: 'passed', summary: '2 inputs, 1 output.', durationMs: 1 },
    {
      id: 'simulation_equivalence',
      title: 'Simulation equivalence',
      status: 'passed',
      summary: 'All 4 assignments agree with the specification.',
      durationMs: 2,
      coverage: { mode: 'exhaustive', checked: 4, space: 4, dontCare: 0 },
    },
    { id: 'reversibility', title: 'Reversibility', status: 'passed', summary: 'Inverse restores every input.', durationMs: 1 },
    { id: 'garbage_free', title: 'Garbage-free', status: 'passed', summary: '1 ancilla, all uncomputed.', durationMs: 1 },
    { id: 'property', title: 'Properties', status: 'passed', summary: 'No properties declared.', durationMs: 0 },
    { id: 'resource', title: 'Resource budget', status: 'passed', summary: 'No budget declared.', durationMs: 0 },
  ],
  checksReached: ['type_shape', 'simulation_equivalence', 'reversibility', 'garbage_free', 'property', 'resource'],
  stoppedAt: null,
  durationMs: 5,
  compilerVersion: '1.0.0',
  optimization: {
    passes: [
      { pass: 'cancel-adjacent', outcome: 'applied', before: 5, after: 4 },
      { pass: 'merge-controls', outcome: 'no_change', before: 4, after: 4 },
    ],
    gatesBefore: 5,
    gatesAfter: 4,
    discarded: 0,
  },
};

export const compileDetail: CompileDetail = {
  job: jobSummary,
  spec: { id: 's1', name: 'spec', kind: 'boolean', source: 'out = a AND b\n', budgets: {} },
  stages: [
    { stage: 'parse', status: 'ok', durationMs: 1 },
    { stage: 'lower', status: 'ok', durationMs: 2 },
    { stage: 'verify', status: 'ok', durationMs: 5 },
  ],
  verification,
  resources: {
    measured: { qubits: 4, inputQubits: 2, ancillaQubits: 1, outputQubits: 1, gateCount: 4, depth: 3 },
    cliffordT: { source: 'measured', gateCount: 30, tCount: 14, tDepth: 6, twoQubitGates: 12 },
  },
  artifacts: [
    { id: 'art-qasm', kind: 'qasm3', contentHash: 'h1', sizeBytes: 120 },
    { id: 'art-rir', kind: 'reversible_ir', contentHash: 'h2', sizeBytes: 400 },
    { id: 'art-qir', kind: 'quantum_ir', contentHash: 'h3', sizeBytes: 900 },
    { id: 'art-trace', kind: 'trace', contentHash: 'h4', sizeBytes: 300 },
  ],
  version: { id: 'v1', number: 1 },
};

export const circuit: ReversibleCircuit = {
  name: 'spec',
  wires: [
    { index: 0, role: 'input', name: 'a' },
    { index: 1, role: 'input', name: 'b' },
    { index: 2, role: 'ancilla', name: 'anc0' },
    { index: 3, role: 'output', name: 'out' },
  ],
  gates: [
    { kind: 'ccnot', wires: [0, 1, 2], span: { line: 1, column: 7 }, nodeId: 3 },
    { kind: 'cnot', wires: [2, 3], span: { line: 1, column: 1 }, nodeId: 4 },
    { kind: 'ccnot', wires: [0, 1, 2], span: { line: 1, column: 7 }, nodeId: 3 },
    { kind: 'x', wires: [3], span: { line: 1, column: 1 } },
  ],
  inputs: [
    { name: 'a', wire: 0 },
    { name: 'b', wire: 1 },
  ],
  outputs: [{ name: 'out', wire: 3 }],
  ancillas: [
    { wire: 2, purpose: 'AND of a and b', nodeId: 3, allocatedAtGate: 0, uncomputedAtGate: 2, releasedAtGate: 2, span: { line: 1, column: 7 } },
  ],
};

export const trace: TraceEntry[] = [
  { seq: 1, phase: 'parse', kind: 'input', message: 'Read 2 inputs from the specification.', span: { line: 1, column: 1 } },
  { seq: 2, phase: 'lower', kind: 'ancilla.allocate', message: 'Allocated anc0 for AND of a and b.', gateIndex: 0, span: { line: 1, column: 7 } },
  { seq: 3, phase: 'lower', kind: 'gate', message: 'Emitted Toffoli onto anc0.', gateIndex: 0, wires: [0, 1, 2] },
  { seq: 4, phase: 'lower', kind: 'ancilla.uncompute', message: 'Uncomputed anc0.', gateIndex: 2 },
  { seq: 5, phase: 'verify', kind: 'check', message: 'Simulation equivalence: 4/4 assignments.' },
];

export const members: Member[] = [
  { userId: 'u1', role: 'owner', email: 'eng@example.com', name: 'Engineer', joinedAt: '2026-09-01T10:00:00.000Z' },
  { userId: 'u2', role: 'viewer', email: 'auditor@example.com', name: 'Auditor', joinedAt: '2026-09-02T10:00:00.000Z' },
];

export const apiKeys: ApiKey[] = [
  {
    id: 'k1',
    name: 'ci-pipeline',
    prefix: 'qs_live_ab',
    scopes: ['compile:run', 'artifact:read'],
    createdAt: '2026-09-03T10:00:00.000Z',
    createdBy: 'u1',
    lastUsedAt: null,
    expiresAt: null,
    revoked: false,
  },
];

export const auditPage: AuditPage = {
  entries: [
    {
      id: 'a1',
      at: '2026-09-10T10:00:01.000Z',
      action: 'compile.succeeded',
      actor: { kind: 'user', id: 'u1', name: 'Engineer', email: 'eng@example.com' },
      resource: { type: 'compile_job', id: 'j1' },
      ip: '203.0.113.7',
      userAgent: 'test',
      metadata: { passed: true },
    },
  ],
  nextBefore: null,
};

export const qasm = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[4] q;\nccx q[0], q[1], q[2];\n';
