/**
 * Route table and request pipeline.
 *
 * Deny-by-default is enforced structurally: `auth` is a required field, so a route
 * cannot be added without deciding its authorization. Choosing to make something
 * public requires writing `auth: 'public'` — a visible, reviewable act, not an omission.
 */
import { authenticate, type Principal } from './auth.js';
import { assertPermission, type Permission } from './authz.js';
import { ApiError, invalid, notFound } from './errors.js';
import { withTx, type Tx } from './db.js';
import { enforceRateLimit, LIMITS } from './ratelimit.js';
import { beginIdempotent, releaseIdempotent } from './idempotency.js';

export interface RequestInfo {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | undefined>;
  readonly body: Record<string, unknown>;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface Ctx extends RequestInfo {
  readonly principal: Principal;
  readonly params: Record<string, string>;
}

export interface PublicCtx extends RequestInfo {
  readonly params: Record<string, string>;
}

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * `'authenticated'` means "any valid principal, no further permission" — it exists for
 * the handful of self-service endpoints (who am I, log myself out) that every role can
 * reach by definition. It is spelled out rather than implied so it still reads as a
 * decision in the route table.
 */
export type RouteAuth = 'public' | 'authenticated' | Permission;

export type Route =
  | {
      method: string;
      path: string;
      auth: 'public';
      rateLimit?: keyof typeof LIMITS;
      handler: (ctx: PublicCtx) => Promise<HttpResult>;
    }
  | {
      method: string;
      path: string;
      auth: Exclude<RouteAuth, 'public'>;
      rateLimit?: keyof typeof LIMITS;
      /** Honour Idempotency-Key. Set on every POST that costs money or creates state. */
      idempotent?: boolean;
      handler: (ctx: Ctx) => Promise<HttpResult>;
    };

export const ok = (body: unknown): HttpResult => ({ status: 200, body });
export const created = (body: unknown): HttpResult => ({ status: 201, body });
export const noContent = (): HttpResult => ({ status: 204, body: null });

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const val = a[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

export async function dispatch(routes: readonly Route[], req: RequestInfo): Promise<HttpResult> {
  let pathMatched = false;

  for (const route of routes) {
    const params = matchPath(route.path, req.path);
    if (!params) continue;
    pathMatched = true;
    if (route.method !== req.method) continue;

    if (route.auth === 'public') {
      return route.handler({ ...req, params });
    }

    const principal = await authenticate(req.headers);
    if (route.auth !== 'authenticated') {
      assertPermission(
        principal.kind === 'session'
          ? { kind: 'session', role: principal.role }
          : { kind: 'api_key', scopes: principal.scopes },
        route.auth,
      );
    }

    const principalId = principal.kind === 'session' ? principal.userId : principal.keyId;
    await withTx({ orgId: principal.orgId, userId: principal.kind === 'session' ? principal.userId : null }, async (tx) => {
      await enforceRateLimit(tx, principal.orgId, LIMITS[route.rateLimit ?? 'default'](principalId));
    });

    const ctx: Ctx = { ...req, principal, params };

    const idempotencyKey = route.idempotent ? req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'] : undefined;
    if (!idempotencyKey) return route.handler(ctx);

    const outcome = await beginIdempotent(principal.orgId, idempotencyKey, req.body);
    if (outcome.kind === 'replay') {
      return { status: outcome.response.status, body: outcome.response.body, headers: { 'Idempotency-Replayed': 'true' } };
    }
    try {
      const result = await route.handler(ctx);
      await outcome.commit({ status: result.status, body: result.body });
      return result;
    } catch (err) {
      await releaseIdempotent(principal.orgId, idempotencyKey);
      throw err;
    }
  }

  if (pathMatched) {
    throw new ApiError(
      'INVALID_REQUEST',
      `Method ${req.method} is not allowed on ${req.path}.`,
      'Check the HTTP method against the API reference.',
    );
  }
  throw notFound(`Route ${req.method} ${req.path}`);
}

/** Small helpers shared by route modules. */
export function requireString(body: Record<string, unknown>, field: string, opts: { max?: number; min?: number } = {}): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`Field "${field}" is required and must be a non-empty string.`, `Include "${field}" in the request body.`, { field });
  }
  const trimmed = value.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) {
    throw invalid(`Field "${field}" must be at least ${opts.min} characters.`, `Use a longer "${field}".`, { field });
  }
  if (opts.max !== undefined && trimmed.length > opts.max) {
    throw invalid(`Field "${field}" must be at most ${opts.max} characters.`, `Shorten "${field}".`, { field });
  }
  return trimmed;
}

export function optionalString(body: Record<string, unknown>, field: string, fallback = ''): string {
  const value = body[field];
  return typeof value === 'string' ? value.trim() : fallback;
}

export const orgTx = <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withTx({ orgId: ctx.principal.orgId, userId: ctx.principal.kind === 'session' ? ctx.principal.userId : null }, fn);
