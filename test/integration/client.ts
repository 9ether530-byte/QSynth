/**
 * Thin HTTP client for integration tests, plus fixture helpers.
 *
 * These tests speak to the deployed API over the network on purpose. Isolation that
 * only holds when you call the handler in-process is not isolation — the thing that
 * must be proven is what an attacker can reach, which is the URL.
 */
import { randomBytes } from 'node:crypto';

export const BASE_URL = (process.env['QSYNTH_API_URL'] ?? '').replace(/\/+$/, '');

if (!BASE_URL) {
  throw new Error(
    'QSYNTH_API_URL is not set. Run: QSYNTH_API_URL=<function url> npm run test:integration',
  );
}

export interface Response<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface Credentials {
  token?: string;
  orgId?: string;
  idempotencyKey?: string;
}

export async function call<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: Credentials } = {},
): Promise<Response<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth?.token) headers['authorization'] = `Bearer ${opts.auth.token}`;
  if (opts.auth?.orgId) headers['x-org-id'] = opts.auth.orgId;
  if (opts.auth?.idempotencyKey) headers['idempotency-key'] = opts.auth.idempotencyKey;

  const sendsBody = method !== 'GET' && method !== 'HEAD' && opts.body !== undefined;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: sendsBody ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

export const unique = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

export interface Tenant {
  email: string;
  password: string;
  userId: string;
  orgId: string;
  token: string;
  /** Sessions and credentials for every extra member created in this org. */
  members: Record<string, { userId: string; email: string; token: string }>;
}

export async function createTenant(label: string): Promise<Tenant> {
  const email = `${unique(label)}@qsynth-test.invalid`;
  const password = 'integration-test-password';
  const res = await call('POST', '/v1/auth/register', {
    body: { email, name: `${label} Owner`, password, organizationName: unique(`Org ${label}`) },
  });
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    email,
    password,
    userId: res.body.user.id,
    orgId: res.body.organization.id,
    token: res.body.token,
    members: {},
  };
}

/** Registers a fresh user, then adds them to `tenant` with `role`, returning their session. */
export async function addMember(
  tenant: Tenant,
  role: 'owner' | 'admin' | 'developer' | 'viewer',
): Promise<{ userId: string; email: string; token: string }> {
  const email = `${unique(role)}@qsynth-test.invalid`;
  const password = 'integration-test-password';
  const reg = await call('POST', '/v1/auth/register', {
    body: { email, name: `${role} user`, password, organizationName: unique(`Personal ${role}`) },
  });
  if (reg.status !== 201) throw new Error(`member register failed: ${JSON.stringify(reg.body)}`);

  const add = await call('POST', '/v1/members', {
    auth: { token: tenant.token, orgId: tenant.orgId },
    body: { email, role },
  });
  if (add.status !== 201) throw new Error(`add member failed: ${JSON.stringify(add.body)}`);

  // The member now belongs to two organizations, so every call must name one.
  const member = { userId: reg.body.user.id, email, token: reg.body.token };
  tenant.members[role] = member;
  return member;
}

export const errorCode = (res: Response): string | undefined => res.body?.error?.code;
