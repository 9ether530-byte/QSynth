/**
 * The HTTP client. One `request` function, one error type, no ambient state beyond the
 * session token.
 *
 * Two rules the rest of the app depends on:
 *
 *   1. **Every failure arrives as an `ApiError` with the server's `code`.** The API's
 *      contract is that a failure carries a stable code, a message, and a hint; throwing
 *      `Error("Request failed")` here would discard exactly the part a user can act on.
 *      Components branch on `code` and render `hint` — never on the prose of `message`.
 *   2. **The export gate is the server's.** Nothing in this file decides whether an
 *      artifact may be downloaded. `VERIFICATION_REQUIRED` comes back as a 403 and is
 *      shown as one; the UI's job is to explain the refusal, not to pre-empt it.
 */
import type {
  ArtifactExport,
  AuditPage,
  ApiKeyCreated,
  CompileDetail,
  CompileResponse,
  EstimateResponse,
  JobSummary,
  Member,
  Organization,
  Principal,
  Project,
  ReverifyResponse,
  SessionResponse,
  SpecKind,
  ApiKey,
  ResourceBudget,
  Role,
} from './types';

/**
 * The Lambda function URL, called directly rather than through the CloudFront `/api`
 * path. One less hop per request, and compile requests are the slowest calls in the app.
 */
export const API_BASE = 'https://qrdigoku2bdkd6apc6ldb5rx2q0vwxdj.lambda-url.us-east-1.on.aws';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, hint: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.details = details;
  }

  /** The source span an editor can put a marker on, when the failure has one. */
  get span(): { line: number; column: number } | null {
    const span = this.details['span'];
    if (!span || typeof span !== 'object') return null;
    const { line, column } = span as { line?: unknown; column?: unknown };
    return typeof line === 'number' ? { line, column: typeof column === 'number' ? column : 1 } : null;
  }
}

/** Set by the session store; read here so no component has to pass a token around. */
let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

/**
 * Which organization the session is acting in.
 *
 * The API refuses to guess for a user who belongs to more than one — it answers
 * `NO_ORG_CONTEXT` rather than picking, because "their first org" is a cross-tenant
 * hazard the moment the order changes. Anyone added to a second organization is in that
 * position, so the header is not an edge case; without it the app is unusable for them.
 */
let activeOrgId: string | null = null;

export function setActiveOrg(orgId: string | null): void {
  activeOrgId = orgId;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;
  if (activeOrgId) headers['x-org-id'] = activeOrgId;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    // A network failure is not an API failure, and saying "request failed" for both hides
    // the one thing the user can check.
    throw new ApiError(0, 'NETWORK', 'The API could not be reached.', 'Check your connection and try again.', {
      cause: String(cause),
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(
      response.status,
      'INTERNAL',
      'The API returned a response that was not JSON.',
      'This is a bug; please report it with the time it happened.',
      { body: text.slice(0, 500) },
    );
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> } })
      .error;
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL',
      error?.message ?? `The request failed with status ${response.status}.`,
      error?.hint ?? 'Try again, or contact support if it persists.',
      error?.details ?? {},
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  register: (body: { email: string; password: string; name: string; organizationName: string }) =>
    request<SessionResponse>('/v1/auth/register', { method: 'POST', body }),

  login: (body: { email: string; password: string }) =>
    request<SessionResponse>('/v1/auth/login', { method: 'POST', body }),

  logout: () => request<{ ended: boolean }>('/v1/auth/logout', { method: 'POST', body: {} }),

  me: () => request<Principal>('/v1/auth/me'),

  organization: () => request<{ organization: Organization }>('/v1/organization'),

  projects: () => request<{ projects: Project[] }>('/v1/projects'),

  project: (id: string) => request<{ project: Project }>(`/v1/projects/${id}`),

  createProject: (body: { name: string; description?: string }) =>
    request<{ project: Project }>('/v1/projects', { method: 'POST', body }),

  archiveProject: (id: string) => request<void>(`/v1/projects/${id}`, { method: 'DELETE' }),

  jobs: (projectId: string) => request<{ jobs: JobSummary[] }>(`/v1/compile?projectId=${encodeURIComponent(projectId)}`),

  job: (id: string) => request<CompileDetail>(`/v1/compile/${id}`),

  compile: (body: { projectId: string; kind: SpecKind; source: string; name?: string; budget?: ResourceBudget }) =>
    request<CompileResponse>('/v1/compile', { method: 'POST', body }),

  estimate: (body: { kind: SpecKind; source: string; name?: string }) =>
    request<EstimateResponse>('/v1/compile/estimate', { method: 'POST', body }),

  reverify: (id: string) => request<ReverifyResponse>(`/v1/compile/${id}/verify`, { method: 'POST', body: {} }),

  artifact: (id: string) => request<ArtifactExport>(`/v1/artifacts/${id}`),

  members: () => request<{ members: Member[] }>('/v1/members'),

  addMember: (body: { email: string; role: Role }) => request<{ member: Member }>('/v1/members', { method: 'POST', body }),

  changeRole: (userId: string, role: Role) =>
    request<{ member: Member }>(`/v1/members/${userId}`, { method: 'PATCH', body: { role } }),

  removeMember: (userId: string) => request<void>(`/v1/members/${userId}`, { method: 'DELETE' }),

  apiKeys: () => request<{ apiKeys: ApiKey[] }>('/v1/api-keys'),

  createApiKey: (body: { name: string; scopes: string[]; expiresInDays?: number }) =>
    request<ApiKeyCreated>('/v1/api-keys', { method: 'POST', body }),

  revokeApiKey: (id: string) => request<void>(`/v1/api-keys/${id}`, { method: 'DELETE' }),

  auditLogs: (params: { limit?: number; before?: string; action?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.before) query.set('before', params.before);
    if (params.action) query.set('action', params.action);
    const suffix = query.toString();
    return request<AuditPage>(`/v1/audit-logs${suffix ? `?${suffix}` : ''}`);
  },
};
