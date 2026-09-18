/**
 * Resolves the caller into a Principal: who they are, which org they are acting in,
 * and what that grants. Two credential types, both presented as `Authorization: Bearer`:
 *
 *   - session token  → user + membership role in the selected org
 *   - API key        → org + explicit scopes (no user, no role)
 *
 * Org selection for sessions: the `X-Org-Id` header when present, otherwise the
 * user's sole membership. A user in several orgs who sends no header gets
 * NO_ORG_CONTEXT rather than an arbitrary pick — guessing would be a cross-tenant
 * hazard the moment someone's "first" org changed.
 */
import { withAuthTx, withTx, type Tx } from './db.js';
import { sha256 } from './crypto.js';
import { ApiError, unauthenticated } from './errors.js';
import type { Role } from './authz.js';

export type Principal =
  | { kind: 'session'; userId: string; orgId: string; role: Role; sessionId: string }
  | { kind: 'api_key'; keyId: string; orgId: string; scopes: readonly string[] };

export function bearerToken(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers['authorization'] ?? headers['Authorization'];
  if (!raw) return undefined;
  const [scheme, ...rest] = raw.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

export async function authenticate(
  headers: Record<string, string | undefined>,
): Promise<Principal> {
  const token = bearerToken(headers);
  if (!token) throw unauthenticated();

  const hash = sha256(token);

  if (token.startsWith('qs_live_')) {
    const row = await withAuthTx(async (tx) =>
      tx.one<{ key_id: string; org_id: string; scopes: string[] }>(
        'select * from auth_api_key($1)',
        [hash],
      ),
    );
    if (!row) {
      throw new ApiError(
        'UNAUTHENTICATED',
        'That API key is not valid, has been revoked, or has expired.',
        'Issue a new key under Settings → API keys.',
      );
    }
    // Record use outside the auth lookup so a write failure cannot deny a valid key.
    void touchApiKey(row.org_id, row.key_id);
    return { kind: 'api_key', keyId: row.key_id, orgId: row.org_id, scopes: row.scopes };
  }

  const session = await withAuthTx(async (tx) =>
    tx.one<{ session_id: string; user_id: string; expires_at: Date }>(
      'select * from auth_session($1)',
      [hash],
    ),
  );
  if (!session) {
    throw new ApiError(
      'SESSION_EXPIRED',
      'Your session is no longer valid.',
      'Sign in again to obtain a new session.',
    );
  }

  const requestedOrg = headers['x-org-id'] ?? headers['X-Org-Id'];
  const memberships = await withTx({ orgId: null, userId: session.user_id }, async (tx) =>
    tx.query<{ org_id: string; role: Role }>(
      'select org_id, role from memberships where user_id = $1 order by created_at',
      [session.user_id],
    ),
  );

  if (memberships.length === 0) {
    throw new ApiError(
      'NOT_A_MEMBER',
      'Your account does not belong to any organization.',
      'Ask an organization owner to invite you, or create your own organization.',
    );
  }

  let membership = memberships[0]!;
  if (requestedOrg) {
    const match = memberships.find((m) => m.org_id === requestedOrg);
    if (!match) {
      // Deliberately indistinguishable from "org does not exist": a non-member must
      // not be able to probe which org ids are real.
      throw new ApiError(
        'NOT_A_MEMBER',
        'You are not a member of the requested organization.',
        'Remove the X-Org-Id header to use your default organization, or request access.',
      );
    }
    membership = match;
  } else if (memberships.length > 1) {
    throw new ApiError(
      'NO_ORG_CONTEXT',
      'Your account belongs to several organizations, so the target is ambiguous.',
      'Send an X-Org-Id header naming the organization to act in.',
      { organizations: memberships.map((m) => m.org_id) },
    );
  }

  return {
    kind: 'session',
    userId: session.user_id,
    orgId: membership.org_id,
    role: membership.role,
    sessionId: session.session_id,
  };
}

async function touchApiKey(orgId: string, keyId: string): Promise<void> {
  try {
    await withTx({ orgId, userId: null }, async (tx) => {
      await tx.query('update api_keys set last_used_at = now() where id = $1', [keyId]);
    });
  } catch {
    // Best-effort telemetry; never fails a request.
  }
}

/** Audit helper — runs inside the caller's transaction so the record commits atomically with the action. */
export async function audit(
  tx: Tx,
  principal: Principal,
  entry: {
    action: string;
    resourceType: string;
    resourceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `insert into audit_logs (org_id, actor_user_id, actor_api_key_id, action, resource_type, resource_id, ip, user_agent, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      principal.orgId,
      principal.kind === 'session' ? principal.userId : null,
      principal.kind === 'api_key' ? principal.keyId : null,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.ip ?? null,
      entry.userAgent ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
