/**
 * Route table and request pipeline.
 *
 * Deny-by-default is enforced structurally: `auth` is a required field, so a route
 * cannot be added without deciding its authorization. Choosing to make something
 * public requires writing `auth: 'public'` — a visible, reviewable act, not an omission.
 *
 * `doc` is required for the same reason. The published endpoint reference is generated
 * from this table, so an undocumented endpoint is a type error rather than a gap
 * somebody notices months later from the outside.
 */
import { authenticate, type Principal } from './auth.js';
import { assertPermission, type Permission } from './authz.js';
import { ApiError, invalid, notFound } from './errors.js';
import { withTx, type Tx } from './db.js';
import { enforceRateLimit, rateLimitHeaders, LIMITS } from './ratelimit.js';
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
      /** One sentence, in the caller's terms. Required — see the note below. */
      doc: string;
      rateLimit?: keyof typeof LIMITS;
      handler: (ctx: PublicCtx) => Promise<HttpResult>;
    }
  | {
      method: string;
      path: string;
      auth: Exclude<RouteAuth, 'public'>;
      /** One sentence, in the caller's terms. Required — see the note below. */
      doc: string;
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

/**
 * An Idempotency-Key is a promise the client makes: "this string identifies this
 * request, and nothing else, forever." The minimum length enforces the only part of
 * that promise we can check. A one-character key is not a shortened uuid, it is a
 * client that has not thought about collisions — and the collision it causes is
 * another caller's response being replayed to it, which is worse than a duplicate.
 */
const KEY_MIN = 8;
const KEY_MAX = 255;

function idempotencyKeyOf(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers['idempotency-key'] ?? headers['Idempotency-Key'];
  if (raw === undefined) return undefined;
  const key = raw.trim();
  if (key.length < KEY_MIN || key.length > KEY_MAX || /[\x00-\x1f\x7f]/.test(key)) {
    throw invalid(
      `Idempotency-Key must be ${KEY_MIN}–${KEY_MAX} printable characters.`,
      'Use a UUID, or omit the header entirely to send a non-idempotent request.',
      { header: 'Idempotency-Key' },
    );
  }
  return key;
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
    const rate = await withTx(
      { orgId: principal.orgId, userId: principal.kind === 'session' ? principal.userId : null },
      async (tx) => enforceRateLimit(tx, principal.orgId, LIMITS[route.rateLimit ?? 'default'](principalId)),
    );
    // Every authenticated response carries the budget, so a client can slow down before
    // it is refused rather than discovering the limit by tripping it.
    const withRate = (result: HttpResult): HttpResult => ({
      ...result,
      headers: { ...rateLimitHeaders(rate), ...(result.headers ?? {}) },
    });

    const ctx: Ctx = { ...req, principal, params };

    const idempotencyKey = route.idempotent ? idempotencyKeyOf(req.headers) : undefined;
    if (!idempotencyKey) return withRate(await route.handler(ctx));

    const outcome = await beginIdempotent(principal.orgId, idempotencyKey, req.body);
    if (outcome.kind === 'replay') {
      return withRate({
        status: outcome.response.status,
        body: outcome.response.body,
        headers: { 'idempotency-replayed': 'true' },
      });
    }
    try {
      const result = await route.handler(ctx);
      await outcome.commit({ status: result.status, body: result.body });
      return withRate(result);
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
