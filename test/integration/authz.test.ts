/**
 * Role × endpoint authorization matrix.
 *
 * The expected matrix below is written out by hand rather than derived from
 * ROLE_PERMISSIONS. Deriving it would make the test a restatement of the
 * implementation — it would pass just as happily if someone gave viewers the ability
 * to delete projects. The table here is the *intent*; the code has to match it.
 *
 * Mutating endpoints are aimed at identifiers that do not exist, so an authorized
 * caller gets 404 and an unauthorized one gets 403. That distinction is the whole
 * assertion, and it costs no fixture cleanup.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { addMember, call, createTenant, errorCode, unique, type Tenant } from './client.js';

type Role = 'owner' | 'admin' | 'developer' | 'viewer';

const ROLES: Role[] = ['owner', 'admin', 'developer', 'viewer'];
const ABSENT = '00000000-0000-4000-8000-000000000000';

interface Case {
  label: string;
  method: string;
  path: string;
  body?: unknown;
  /** Roles that must be allowed through. Everyone else must receive 403. */
  allowed: Role[];
}

const MATRIX: Case[] = [
  { label: 'list projects', method: 'GET', path: '/v1/projects', allowed: ['owner', 'admin', 'developer', 'viewer'] },
  { label: 'read project', method: 'GET', path: `/v1/projects/${ABSENT}`, allowed: ['owner', 'admin', 'developer', 'viewer'] },
  { label: 'create project', method: 'POST', path: '/v1/projects', body: { name: 'authz probe' }, allowed: ['owner', 'admin', 'developer'] },
  { label: 'update project', method: 'PATCH', path: `/v1/projects/${ABSENT}`, body: { name: 'x' }, allowed: ['owner', 'admin', 'developer'] },
  { label: 'delete project', method: 'DELETE', path: `/v1/projects/${ABSENT}`, allowed: ['owner', 'admin'] },

  // Compiling costs CPU and creates artifacts, so it sits with the write permissions;
  // reading a report and exporting a verified artifact are available to viewers, who are
  // exactly the people (reviewers, auditors) who need to read a verdict without running one.
  { label: 'list compile jobs', method: 'GET', path: '/v1/compile', allowed: ['owner', 'admin', 'developer', 'viewer'] },
  { label: 'read compile job', method: 'GET', path: `/v1/compile/${ABSENT}`, allowed: ['owner', 'admin', 'developer', 'viewer'] },
  {
    label: 'run a compile',
    method: 'POST',
    path: '/v1/compile',
    body: { projectId: ABSENT, kind: 'boolean', source: 'in a, b\nout = a AND b' },
    allowed: ['owner', 'admin', 'developer'],
  },
  {
    label: 'estimate a compile',
    method: 'POST',
    path: '/v1/compile/estimate',
    body: { kind: 'boolean', source: 'in a, b\nout = a AND b' },
    allowed: ['owner', 'admin', 'developer'],
  },
  { label: 're-verify a job', method: 'POST', path: `/v1/compile/${ABSENT}/verify`, body: {}, allowed: ['owner', 'admin', 'developer'] },
  { label: 'export an artifact', method: 'GET', path: `/v1/artifacts/${ABSENT}`, allowed: ['owner', 'admin', 'developer', 'viewer'] },

  { label: 'read organization', method: 'GET', path: '/v1/organization', allowed: ['owner', 'admin', 'developer', 'viewer'] },
  { label: 'rename organization', method: 'PATCH', path: '/v1/organization', body: { name: 'Renamed by authz probe' }, allowed: ['owner'] },

  { label: 'list members', method: 'GET', path: '/v1/members', allowed: ['owner', 'admin', 'developer', 'viewer'] },
  { label: 'add member', method: 'POST', path: '/v1/members', body: { email: 'nobody@qsynth-test.invalid', role: 'viewer' }, allowed: ['owner', 'admin'] },
  { label: 'change member role', method: 'PATCH', path: `/v1/members/${ABSENT}`, body: { role: 'viewer' }, allowed: ['owner', 'admin'] },
  { label: 'remove member', method: 'DELETE', path: `/v1/members/${ABSENT}`, allowed: ['owner', 'admin'] },

  { label: 'list api keys', method: 'GET', path: '/v1/api-keys', allowed: ['owner', 'admin'] },
  { label: 'create api key', method: 'POST', path: '/v1/api-keys', body: { name: 'probe', scopes: ['project:read'] }, allowed: ['owner', 'admin'] },
  { label: 'revoke api key', method: 'DELETE', path: `/v1/api-keys/${ABSENT}`, allowed: ['owner', 'admin'] },

  { label: 'read audit log', method: 'GET', path: '/v1/audit-logs', allowed: ['owner', 'admin'] },
];

let org: Tenant;
const sessions: Record<Role, { token: string; orgId: string; userId: string }> = {} as never;

beforeAll(async () => {
  org = await createTenant('matrix');
  sessions.owner = { token: org.token, orgId: org.orgId, userId: org.userId };
  for (const role of ['admin', 'developer', 'viewer'] as const) {
    const member = await addMember(org, role);
    sessions[role] = { token: member.token, orgId: org.orgId, userId: member.userId };
  }
});

describe('role × endpoint matrix', () => {
  for (const testCase of MATRIX) {
    for (const role of ROLES) {
      const shouldAllow = testCase.allowed.includes(role);
      it(`${role} ${shouldAllow ? 'may' : 'may NOT'} ${testCase.label}`, async () => {
        const res = await call(testCase.method, testCase.path, {
          auth: sessions[role],
          body: testCase.body,
        });

        if (shouldAllow) {
          expect(res.status, JSON.stringify(res.body)).not.toBe(403);
          expect(res.status, JSON.stringify(res.body)).not.toBe(401);
          expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
        } else {
          expect(res.status, JSON.stringify(res.body)).toBe(403);
          expect(errorCode(res)).toBe('FORBIDDEN');
        }
      });
    }
  }
});

describe('privilege escalation guards', () => {
  it('refuses to grant a role above the caller\'s own', async () => {
    const res = await call('PATCH', `/v1/members/${sessions.developer.userId}`, {
      auth: sessions.admin,
      body: { role: 'owner' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details.requested).toBe('owner');
  });

  it('refuses to demote an owner from below', async () => {
    const res = await call('PATCH', `/v1/members/${org.userId}`, {
      auth: sessions.admin,
      body: { role: 'viewer' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses to remove an owner from below', async () => {
    const res = await call('DELETE', `/v1/members/${org.userId}`, { auth: sessions.admin });
    expect(res.status).toBe(403);
  });

  it('refuses to remove the last owner, even as that owner', async () => {
    const res = await call('DELETE', `/v1/members/${org.userId}`, { auth: sessions.owner });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('CONFLICT');
  });

  it('refuses an API key scope the creator does not hold', async () => {
    const res = await call('POST', '/v1/api-keys', {
      auth: sessions.admin,
      body: { name: 'over-scoped', scopes: ['project:read', 'org:write'] },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details.excess).toEqual(['org:write']);
  });

  it('confines an API key to the scopes it was issued with', async () => {
    const issued = await call('POST', '/v1/api-keys', {
      auth: sessions.owner,
      body: { name: 'read only', scopes: ['project:read'] },
    });
    expect(issued.status).toBe(201);
    const secret: string = issued.body.secret;

    expect((await call('GET', '/v1/projects', { auth: { token: secret } })).status).toBe(200);

    const write = await call('POST', '/v1/projects', { auth: { token: secret }, body: { name: 'nope' } });
    expect(write.status).toBe(403);
    expect(write.body.error.details.required).toBe('project:write');
  });

  it('does not let an API key change membership even with the scope', async () => {
    const issued = await call('POST', '/v1/api-keys', {
      auth: sessions.owner,
      body: { name: 'member writer', scopes: ['member:read', 'member:write'] },
    });
    const secret: string = issued.body.secret;

    const res = await call('POST', '/v1/members', {
      auth: { token: secret },
      body: { email: 'nobody@qsynth-test.invalid', role: 'viewer' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/API keys cannot change organization membership/);
  });

  it('returns only the scopes granted, never the creator\'s full role', async () => {
    const issued = await call('POST', '/v1/api-keys', {
      auth: sessions.owner,
      body: { name: 'introspection', scopes: ['project:read'] },
    });
    const me = await call('GET', '/v1/auth/me', { auth: { token: issued.body.secret } });
    expect(me.status).toBe(200);
    expect(me.body.principal).toBe('api_key');
    expect(me.body.scopes).toEqual(['project:read']);
    expect(me.body).not.toHaveProperty('permissions');
  });
});

describe('idempotency', () => {
  it('replays the original response instead of creating a second project', async () => {
    const key = unique('idem');
    const body = { name: 'Idempotent project', description: 'created once' };

    const first = await call('POST', '/v1/projects', { auth: { ...sessions.owner, idempotencyKey: key }, body });
    expect(first.status).toBe(201);

    const second = await call('POST', '/v1/projects', { auth: { ...sessions.owner, idempotencyKey: key }, body });
    expect(second.status).toBe(201);
    expect(second.body.project.id).toBe(first.body.project.id);
    expect(second.headers.get('idempotency-replayed')).toBe('true');

    const list = await call('GET', '/v1/projects', { auth: sessions.owner });
    const matches = list.body.projects.filter((p: { name: string }) => p.name === 'Idempotent project');
    expect(matches).toHaveLength(1);
  });

  it('refuses a reused key carrying a different body', async () => {
    const key = unique('idem');
    const first = await call('POST', '/v1/projects', {
      auth: { ...sessions.owner, idempotencyKey: key },
      body: { name: 'First body' },
    });
    expect(first.status).toBe(201);

    const second = await call('POST', '/v1/projects', {
      auth: { ...sessions.owner, idempotencyKey: key },
      body: { name: 'Different body' },
    });
    expect(second.status).toBe(422);
    expect(errorCode(second)).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('audit trail', () => {
  it('records who did what, and cannot be altered', async () => {
    const project = await call('POST', '/v1/projects', {
      auth: sessions.developer,
      body: { name: unique('audited') },
    });
    expect(project.status).toBe(201);

    const log = await call('GET', '/v1/audit-logs?action=project.create', { auth: sessions.owner });
    expect(log.status).toBe(200);
    const entry = log.body.entries.find((e: { resource: { id: string } }) => e.resource.id === project.body.project.id);
    expect(entry).toBeDefined();
    expect(entry.actor.kind).toBe('user');
    expect(entry.actor.id).toBe(sessions.developer.userId);

    // No route exists to mutate the log; the absence is the control.
    const tamper = await call('DELETE', `/v1/audit-logs/${entry.id}`, { auth: sessions.owner });
    expect(tamper.status).toBe(404);
  });
});
