/**
 * Tenant isolation, proven over the network against the deployed API.
 *
 * The gate for the rest of the project: nothing else ships until every one of these
 * passes. They assert the *absence* of a capability, which is the only kind of
 * security assertion worth making — "org A can read its own projects" proves nothing
 * about whether it can read org B's.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { addMember, call, createTenant, errorCode, unique, type Tenant } from './client.js';

let alpha: Tenant;
let beta: Tenant;
let alphaProject: string;
let betaProject: string;

beforeAll(async () => {
  [alpha, beta] = await Promise.all([createTenant('alpha'), createTenant('beta')]);

  const a = await call('POST', '/v1/projects', {
    auth: { token: alpha.token },
    body: { name: 'Alpha secret project', description: 'alpha-only' },
  });
  expect(a.status).toBe(201);
  alphaProject = a.body.project.id;

  const b = await call('POST', '/v1/projects', {
    auth: { token: beta.token },
    body: { name: 'Beta secret project', description: 'beta-only' },
  });
  expect(b.status).toBe(201);
  betaProject = b.body.project.id;
});

describe('cross-tenant resource access', () => {
  it('does not leak another org\'s project in a list', async () => {
    const res = await call('GET', '/v1/projects', { auth: { token: alpha.token } });
    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(alphaProject);
    expect(ids).not.toContain(betaProject);
  });

  it('refuses a targeted read of another org\'s project', async () => {
    const res = await call('GET', `/v1/projects/${betaProject}`, { auth: { token: alpha.token } });
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe('NOT_FOUND');
  });

  it('refuses an update of another org\'s project', async () => {
    const res = await call('PATCH', `/v1/projects/${betaProject}`, {
      auth: { token: alpha.token },
      body: { name: 'hijacked' },
    });
    expect(res.status).toBe(404);

    // And the target is genuinely untouched, not merely reported as missing.
    const check = await call('GET', `/v1/projects/${betaProject}`, { auth: { token: beta.token } });
    expect(check.status).toBe(200);
    expect(check.body.project.name).toBe('Beta secret project');
  });

  it('refuses a delete of another org\'s project', async () => {
    const res = await call('DELETE', `/v1/projects/${betaProject}`, { auth: { token: alpha.token } });
    expect(res.status).toBe(404);

    const check = await call('GET', `/v1/projects/${betaProject}`, { auth: { token: beta.token } });
    expect(check.status).toBe(200);
  });

  it('does not leak another org\'s member roster', async () => {
    const res = await call('GET', '/v1/members', { auth: { token: alpha.token } });
    expect(res.status).toBe(200);
    const emails = res.body.members.map((m: { email: string }) => m.email);
    expect(emails).toContain(alpha.email);
    expect(emails).not.toContain(beta.email);
  });

  it('does not leak another org\'s audit log', async () => {
    const res = await call('GET', '/v1/audit-logs', { auth: { token: alpha.token } });
    expect(res.status).toBe(200);
    const resources = res.body.entries.map((e: { resource: { id: string | null } }) => e.resource.id);
    expect(resources).not.toContain(betaProject);
  });

  it('does not leak another org\'s API keys', async () => {
    const betaKey = await call('POST', '/v1/api-keys', {
      auth: { token: beta.token },
      body: { name: 'beta key', scopes: ['project:read'] },
    });
    expect(betaKey.status).toBe(201);

    const res = await call('GET', '/v1/api-keys', { auth: { token: alpha.token } });
    expect(res.status).toBe(200);
    const ids = res.body.apiKeys.map((k: { id: string }) => k.id);
    expect(ids).not.toContain(betaKey.body.apiKey.id);

    // Revoking someone else's key by id must also fail.
    const revoke = await call('DELETE', `/v1/api-keys/${betaKey.body.apiKey.id}`, { auth: { token: alpha.token } });
    expect(revoke.status).toBe(404);
  });
});

describe('org context selection', () => {
  it('refuses an X-Org-Id the caller is not a member of', async () => {
    const res = await call('GET', '/v1/projects', { auth: { token: alpha.token, orgId: beta.orgId } });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('NOT_A_MEMBER');
  });

  it('gives the same answer for a non-existent org as for one you cannot see', async () => {
    const fake = '00000000-0000-4000-8000-000000000000';
    const nonMember = await call('GET', '/v1/projects', { auth: { token: alpha.token, orgId: beta.orgId } });
    const nonExistent = await call('GET', '/v1/projects', { auth: { token: alpha.token, orgId: fake } });
    expect(nonExistent.status).toBe(nonMember.status);
    expect(errorCode(nonExistent)).toBe(errorCode(nonMember));
  });

  it('requires an explicit org when the user belongs to more than one', async () => {
    const dual = await addMember(alpha, 'developer');
    const res = await call('GET', '/v1/projects', { auth: { token: dual.token } });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('NO_ORG_CONTEXT');

    const scoped = await call('GET', '/v1/projects', { auth: { token: dual.token, orgId: alpha.orgId } });
    expect(scoped.status).toBe(200);
  });

  it('scopes a multi-org user to the org they named, not the other', async () => {
    const dual = alpha.members['developer']!;
    const own = await call('GET', '/v1/projects', { auth: { token: dual.token, orgId: alpha.orgId } });
    const ids = own.body.projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(alphaProject);
    expect(ids).not.toContain(betaProject);
  });
});

describe('credential handling', () => {
  it('rejects every non-public route without a token', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/v1/projects'],
      ['POST', '/v1/projects'],
      ['GET', `/v1/projects/${alphaProject}`],
      ['PATCH', `/v1/projects/${alphaProject}`],
      ['DELETE', `/v1/projects/${alphaProject}`],
      ['GET', '/v1/organization'],
      ['PATCH', '/v1/organization'],
      ['GET', '/v1/members'],
      ['POST', '/v1/members'],
      ['GET', '/v1/api-keys'],
      ['POST', '/v1/api-keys'],
      ['GET', '/v1/audit-logs'],
      ['GET', '/v1/auth/me'],
      ['POST', '/v1/auth/logout'],
    ];
    for (const [method, path] of routes) {
      const res = await call(method, path, { body: {} });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(errorCode(res), `${method} ${path}`).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects a forged or truncated token', async () => {
    const forged = await call('GET', '/v1/projects', { auth: { token: 'not-a-real-token' } });
    expect(forged.status).toBe(401);

    const truncated = await call('GET', '/v1/projects', { auth: { token: alpha.token.slice(0, -4) } });
    expect(truncated.status).toBe(401);
  });

  it('stops accepting a session token after logout', async () => {
    const throwaway = await createTenant('logout');
    const before = await call('GET', '/v1/auth/me', { auth: { token: throwaway.token } });
    expect(before.status).toBe(200);

    const out = await call('POST', '/v1/auth/logout', { auth: { token: throwaway.token }, body: {} });
    expect(out.status).toBe(200);

    const after = await call('GET', '/v1/auth/me', { auth: { token: throwaway.token } });
    expect(after.status).toBe(401);
    expect(errorCode(after)).toBe('SESSION_EXPIRED');
  });

  it('does not distinguish an unknown email from a wrong password', async () => {
    const wrongPassword = await call('POST', '/v1/auth/login', {
      body: { email: alpha.email, password: 'definitely-not-the-password' },
    });
    const unknownEmail = await call('POST', '/v1/auth/login', {
      body: { email: `${unique('ghost')}@qsynth-test.invalid`, password: 'definitely-not-the-password' },
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(errorCode(wrongPassword)).toBe('INVALID_CREDENTIALS');
    expect(errorCode(unknownEmail)).toBe(errorCode(wrongPassword));
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
  });
});

describe('API key isolation', () => {
  it('confines a key to the org that issued it', async () => {
    const issued = await call('POST', '/v1/api-keys', {
      auth: { token: alpha.token },
      body: { name: 'alpha reader', scopes: ['project:read'] },
    });
    expect(issued.status).toBe(201);
    const secret: string = issued.body.secret;

    const own = await call('GET', '/v1/projects', { auth: { token: secret } });
    expect(own.status).toBe(200);
    expect(own.body.projects.map((p: { id: string }) => p.id)).toContain(alphaProject);

    // An API key carries its own org; X-Org-Id must not be able to redirect it.
    const redirected = await call('GET', '/v1/projects', { auth: { token: secret, orgId: beta.orgId } });
    expect(redirected.status).toBe(200);
    const ids = redirected.body.projects.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(betaProject);
    expect(ids).toContain(alphaProject);

    const target = await call('GET', `/v1/projects/${betaProject}`, { auth: { token: secret } });
    expect(target.status).toBe(404);
  });

  it('stops accepting a key once revoked', async () => {
    const issued = await call('POST', '/v1/api-keys', {
      auth: { token: alpha.token },
      body: { name: 'short lived', scopes: ['project:read'] },
    });
    const secret: string = issued.body.secret;
    expect((await call('GET', '/v1/projects', { auth: { token: secret } })).status).toBe(200);

    const revoked = await call('DELETE', `/v1/api-keys/${issued.body.apiKey.id}`, { auth: { token: alpha.token } });
    expect(revoked.status).toBe(204);

    const after = await call('GET', '/v1/projects', { auth: { token: secret } });
    expect(after.status).toBe(401);
    expect(errorCode(after)).toBe('UNAUTHENTICATED');
  });
});
