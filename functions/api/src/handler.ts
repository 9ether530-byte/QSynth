/**
 * Lambda entry point.
 *
 * The function is reachable two ways — directly on its Function URL (`/v1/...`) and
 * through the CloudFront distribution that fronts the site (`/api/v1/...`) — so the
 * `/api` prefix is stripped rather than assumed either way. Getting this wrong would
 * make the API work in development and 404 in production, or the reverse.
 */
import { COMPILER_VERSION } from '@qsynth/core';
import { ApiError } from './errors.js';
import { errorTable } from './errorcatalog.js';
import { dispatch, type HttpResult, type RequestInfo, type Route } from './router.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { memberRoutes } from './routes/members.js';
import { apiKeyRoutes } from './routes/apikeys.js';
import { auditRoutes } from './routes/audit.js';
import { compileRoutes } from './routes/compile.js';

const VERSION = process.env['QSYNTH_VERSION'] ?? 'dev';

export const ROUTES: readonly Route[] = [
  ...authRoutes,
  ...projectRoutes,
  ...compileRoutes,
  ...memberRoutes,
  ...apiKeyRoutes,
  ...auditRoutes,
  {
    method: 'GET',
    path: '/v1/health',
    doc: 'Report that the API is reachable, and which compiler version it is running.',
    auth: 'public',
    // `compilerVersion` is the number that matters to a caller: it is stamped into every
    // artifact and report, so a client that pins golden output knows from here alone
    // whether a redeploy could change its bytes. `version` is the deployment label.
    handler: async () => ({
      status: 200,
      body: { ok: true, service: 'qsynth-api', version: VERSION, compilerVersion: COMPILER_VERSION },
    }),
  },
  {
    // Public on purpose: the error contract is not a secret, and a client library that
    // can fetch the table can generate its own enum and retry policy from the same
    // source this server answers from, rather than from a copy that ages.
    method: 'GET',
    path: '/v1/errors',
    doc: 'Return the full error-code table this build can answer with.',
    auth: 'public',
    handler: async () => ({ status: 200, body: { errors: errorTable() } }),
  },
];

const MAX_BODY_BYTES = 1_000_000;

/**
 * Credentials travel in the Authorization header, never in a cookie, so there is no
 * ambient authority for a third-party page to abuse and `*` is safe here. If a cookie
 * is ever introduced this must become an explicit allow-list with credentials: true.
 */
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-org-id,idempotency-key',
  // Without this a browser client cannot read any of these: cross-origin responses
  // expose only a handful of headers by default, so the rate-limit budget we are at
  // pains to report would be visible to curl and invisible to the workbench.
  'access-control-expose-headers': 'retry-after,ratelimit-limit,ratelimit-remaining,ratelimit-reset,idempotency-replayed',
  'access-control-max-age': '86400',
};

interface LambdaEvent {
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: { method?: string; path?: string; sourceIp?: string; userAgent?: string };
  };
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function respond(result: HttpResult): LambdaResponse {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
    ...(result.headers ?? {}),
  };
  if (result.status === 204) return { statusCode: 204, headers, body: '' };
  return { statusCode: result.status, headers, body: JSON.stringify(result.body) };
}

function normalizePath(raw: string): string {
  let path = raw || '/';
  if (path.startsWith('/api/')) path = path.slice(4);
  else if (path === '/api') path = '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

function parseBody(event: LambdaEvent): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > MAX_BODY_BYTES) {
    throw new ApiError('SPEC_TOO_LARGE', 'Request body exceeds 1 MB.', 'Send a smaller specification.');
  }
  if (raw.trim() === '') return {};

  const contentType = (event.headers?.['content-type'] ?? event.headers?.['Content-Type'] ?? '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    throw new ApiError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Content-Type "${contentType}" is not supported.`,
      'Send application/json.',
    );
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError('INVALID_REQUEST', 'Request body must be a JSON object.', 'Wrap the payload in an object.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('INVALID_REQUEST', 'Request body is not valid JSON.', 'Check for a trailing comma or unquoted key.');
  }
}

function lowercaseHeaders(headers: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = normalizePath(event.rawPath ?? event.requestContext?.http?.path ?? '/');

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: { ...CORS }, body: '' };
  }

  const started = Date.now();
  try {
    const headers = lowercaseHeaders(event.headers);
    const req: RequestInfo = {
      method,
      path,
      query: new URLSearchParams(event.rawQueryString ?? ''),
      headers,
      body: parseBody(event),
      // The Function URL's sourceIp is the real client; behind CloudFront the original
      // is in x-forwarded-for, whose first entry is the client and the rest are proxies.
      ip:
        headers['x-forwarded-for']?.split(',')[0]?.trim() ??
        event.requestContext?.http?.sourceIp ??
        null,
      userAgent: headers['user-agent'] ?? event.requestContext?.http?.userAgent ?? null,
    };

    const result = await dispatch(ROUTES, req);
    console.log(JSON.stringify({ level: 'info', method, path, status: result.status, ms: Date.now() - started }));
    return respond(result);
  } catch (err) {
    if (err instanceof ApiError) {
      console.log(
        JSON.stringify({ level: 'warn', method, path, status: err.status, code: err.code, ms: Date.now() - started }),
      );
      const extra: Record<string, string> = {};
      const retryAfter = err.details['retryAfter'];
      if (typeof retryAfter === 'number') extra['retry-after'] = String(retryAfter);
      // The refusal itself is thrown before the response headers are assembled, so the
      // budget it reports travels in the error's details and is turned back into the
      // same headers a successful response would have carried.
      for (const field of ['limit', 'remaining', 'reset'] as const) {
        const value = err.details[field];
        if (typeof value === 'number') extra[`ratelimit-${field}`] = String(value);
      }
      return respond({ status: err.status, body: err.toBody(), headers: extra });
    }

    // Unexpected. Log the stack for us; tell the caller nothing about our internals.
    console.error(
      JSON.stringify({
        level: 'error',
        method,
        path,
        ms: Date.now() - started,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    const internal = new ApiError(
      'INTERNAL',
      'The request could not be completed due to an unexpected error.',
      'Retry shortly. If it persists, contact support with the time of the request.',
    );
    return respond({ status: internal.status, body: internal.toBody() });
  }
}
