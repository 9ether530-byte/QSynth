/**
 * The public contract, checked against the deployed API rather than the source.
 *
 * Everything here is something a third-party client depends on and cannot work around:
 * the error envelope, the published error table, the rate-limit budget, and the rules
 * for an Idempotency-Key. A change that breaks one of these breaks integrations that
 * are not in this repository, which is exactly why they are pinned against the URL and
 * not against the handler.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createTenant, errorCode, unique, type Tenant } from './client.js';
import { ERROR_CATALOG, ERROR_CODES } from '../../functions/api/src/errorcatalog.js';

let tenant: Tenant;

beforeAll(async () => {
  tenant = await createTenant('contract');
}, 60_000);

describe('the published error table', () => {
  it('is served, and matches the table this build was compiled from', async () => {
    const res = await call('GET', '/v1/errors');
    expect(res.status).toBe(200);

    const live: Array<{ code: string; status: number; retryable: boolean; meaning: string; resolution: string }> =
      res.body.errors;
    // A deployed API that answers with codes the reference does not list — or lists codes
    // it will never send — is a reference nobody can trust. Both directions are checked.
    expect(live.map((e) => e.code).sort()).toEqual([...ERROR_CODES].sort());
    for (const entry of live) {
      const local = ERROR_CATALOG[entry.code as keyof typeof ERROR_CATALOG];
      expect(entry.status, entry.code).toBe(local.status);
      expect(entry.retryable, entry.code).toBe(local.retryable);
    }
  });

  it('needs no credential, because the contract is not a secret', async () => {
    const res = await call('GET', '/v1/errors');
    expect(res.status).toBe(200);
    expect(res.body.errors.length).toBeGreaterThan(10);
  });

  it('describes real refusals in the terms the table promises', async () => {
    const unauthorized = await call('GET', '/v1/projects');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error.retryable).toBe(false);
    expect(unauthorized.body.error.hint).toBeTruthy();

    const missing = await call('GET', '/v1/projects/00000000-0000-0000-0000-000000000000', {
      auth: { token: tenant.token, orgId: tenant.orgId },
    });
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe('NOT_FOUND');
    expect(missing.body.error.retryable).toBe(false);
  });
});

describe('the rate-limit budget', () => {
  it('is reported on every authenticated response, not only the refused one', async () => {
    const res = await call('GET', '/v1/projects', { auth: { token: tenant.token, orgId: tenant.orgId } });
    expect(res.status).toBe(200);

    const limit = Number(res.headers.get('ratelimit-limit'));
    const remaining = Number(res.headers.get('ratelimit-remaining'));
    const reset = Number(res.headers.get('ratelimit-reset'));
    expect(limit).toBeGreaterThan(0);
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThan(limit);
    // Seconds remaining in the window, so no clock agreement is needed with the caller.
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(60);
  });

  it('is readable by a browser, not only by curl', async () => {
    const res = await call('GET', '/v1/projects', { auth: { token: tenant.token, orgId: tenant.orgId } });
    // The workbench is served from a different origin than the API, so a header the
    // response carries but does not expose might as well not exist there.
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    for (const header of ['retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
      expect(exposed, header).toContain(header);
    }
  });

  it('counts down as the caller spends it', async () => {
    const first = await call('GET', '/v1/projects', { auth: { token: tenant.token, orgId: tenant.orgId } });
    const second = await call('GET', '/v1/projects', { auth: { token: tenant.token, orgId: tenant.orgId } });
    expect(Number(second.headers.get('ratelimit-remaining'))).toBeLessThan(
      Number(first.headers.get('ratelimit-remaining')),
    );
  });

  it('refuses a burst with Retry-After, and charges the burst to that caller alone', async () => {
    // The burst is spent through a throwaway API key so it exhausts that key's bucket
    // and nobody else's — which is also the property being asserted at the end.
    const key = await call('POST', '/v1/api-keys', {
      auth: { token: tenant.token, orgId: tenant.orgId },
      body: { name: unique('burst'), scopes: ['compile:run'] },
    });
    expect(key.status).toBe(201);

    const spec = { kind: 'boolean', source: 'out = a AND b' };
    // Sequential, not concurrent. A parallel burst is throttled by Lambda's own
    // concurrency cap first, which answers 429 with AWS's body rather than ours — it
    // would look like a pass while testing nothing about this limiter.
    const attempts = [];
    for (let i = 0; i < 26; i++) {
      attempts.push(await call('POST', '/v1/compile/estimate', { auth: { token: key.body.secret }, body: spec }));
    }

    const refused = attempts.filter((r) => r.status === 429);
    expect(refused.length).toBeGreaterThan(0);
    const first = refused[0]!;
    expect(errorCode(first)).toBe('RATE_LIMITED');
    expect(first.body.error.retryable).toBe(true);
    expect(Number(first.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(first.headers.get('ratelimit-remaining')).toBe('0');
    // Nothing between 200 and 429: a partial or truncated success would be worse than
    // either, because a client cannot tell whether the work happened.
    expect(attempts.every((r) => r.status === 200 || r.status === 429)).toBe(true);

    // The owner's own budget is untouched: limits are per principal, so one runaway
    // script cannot lock its colleagues out of the organization.
    const owner = await call('POST', '/v1/compile/estimate', {
      auth: { token: tenant.token, orgId: tenant.orgId },
      body: spec,
    });
    expect(owner.status).toBe(200);
  }, 120_000);
});

describe('Idempotency-Key', () => {
  it('refuses a key too short to be unique, instead of accepting a collision', async () => {
    const res = await call('POST', '/v1/projects', {
      auth: { token: tenant.token, orgId: tenant.orgId, idempotencyKey: 'abc' },
      body: { name: unique('short-key') },
    });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('INVALID_REQUEST');
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
  });

  it('accepts a uuid and replays it', async () => {
    const idempotencyKey = crypto.randomUUID();
    const body = { name: unique('replayed') };
    const first = await call('POST', '/v1/projects', {
      auth: { token: tenant.token, orgId: tenant.orgId, idempotencyKey },
      body,
    });
    const second = await call('POST', '/v1/projects', {
      auth: { token: tenant.token, orgId: tenant.orgId, idempotencyKey },
      body,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.project.id).toBe(first.body.project.id);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    // And the replay still reports the budget, since it consumed a request either way.
    expect(second.headers.get('ratelimit-limit')).toBeTruthy();
  });
});
