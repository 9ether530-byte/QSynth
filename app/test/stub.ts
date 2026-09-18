/**
 * The stubbed API object, in a module of its own.
 *
 * It has to stay free of any import that reaches `src/lib/api`, directly or through a
 * component. The `vi.mock` factory awaits this module, so if loading it pulled in the
 * module being mocked, the factory would wait on itself and the test file would hang
 * rather than fail — which is exactly what happened when this lived in `harness.tsx`
 * alongside the `App` import.
 */
import { vi } from 'vitest';
import * as fixtures from './fixtures';

const artifactContent: Record<string, string> = {
  'art-qasm': fixtures.qasm,
  'art-rir': JSON.stringify(fixtures.circuit),
  'art-qir': JSON.stringify({ name: 'spec', qubits: 4, gates: [] }),
  'art-trace': JSON.stringify(fixtures.trace),
};

export const apiStub = {
  register: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(async () => ({ ended: true })),
  me: vi.fn(async () => fixtures.principal),
  organization: vi.fn(async () => ({
    organization: {
      id: 'o1',
      name: 'Acme Quantum',
      slug: 'acme',
      plan: 'free',
      dataRegion: 'us-east-1',
      createdAt: '2026-09-01T10:00:00.000Z',
    },
  })),
  projects: vi.fn(async () => ({ projects: [fixtures.project] })),
  project: vi.fn(async () => ({ project: fixtures.project })),
  createProject: vi.fn(async () => ({ project: fixtures.project })),
  archiveProject: vi.fn(async () => undefined),
  jobs: vi.fn(async () => ({ jobs: [fixtures.jobSummary] })),
  job: vi.fn(async (_id: string) => fixtures.compileDetail),
  compile: vi.fn(),
  estimate: vi.fn(),
  reverify: vi.fn(),
  artifact: vi.fn(async (id: string) => ({
    artifact: { id, kind: 'reversible_ir', contentHash: 'h', sizeBytes: 1, createdAt: '2026-09-10T10:00:00.000Z' },
    verifiedBy: { jobId: 'j1', specHash: fixtures.jobSummary.specHash },
    content: artifactContent[id] ?? '{}',
  })),
  members: vi.fn(async () => ({ members: fixtures.members })),
  addMember: vi.fn(),
  changeRole: vi.fn(),
  removeMember: vi.fn(),
  apiKeys: vi.fn(async () => ({ apiKeys: fixtures.apiKeys })),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  auditLogs: vi.fn(async () => fixtures.auditPage),
};
