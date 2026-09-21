/**
 * API keys.
 *
 * Two rules make a key strictly weaker than the person who created it:
 *   - scopes must be a subset of the creator's own effective permissions
 *   - a key's permissions are its scopes, frozen at creation — promoting the creator
 *     later does not promote their keys, and demoting them does not silently keep
 *     the key working beyond its grant (the route table checks scopes directly)
 *
 * The secret is returned exactly once, at creation. Only its SHA-256 is stored, so
 * there is no recovery path — which is the point.
 */
import { audit } from '../auth.js';
import { ApiError, invalid, notFound } from '../errors.js';
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '../authz.js';
import { mintApiKey } from '../crypto.js';
import { created, noContent, ok, orgTx, requireString, type Ctx, type Route } from '../router.js';

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: Date;
  created_by: string | null;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const view = (k: KeyRow) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes,
  createdAt: k.created_at,
  createdBy: k.created_by,
  lastUsedAt: k.last_used_at,
  expiresAt: k.expires_at,
  revoked: k.revoked_at !== null,
});

function effectivePermissions(ctx: Ctx): readonly string[] {
  return ctx.principal.kind === 'session' ? ROLE_PERMISSIONS[ctx.principal.role] : ctx.principal.scopes;
}

function requireScopes(ctx: Ctx): Permission[] {
  const raw = ctx.body['scopes'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid('At least one scope is required.', `Choose from: ${PERMISSIONS.join(', ')}.`, {
      field: 'scopes',
      allowed: PERMISSIONS,
    });
  }
  const unknown = raw.filter((s) => typeof s !== 'string' || !PERMISSIONS.includes(s as Permission));
  if (unknown.length > 0) {
    throw invalid(`Unknown scope(s): ${unknown.join(', ')}.`, `Choose from: ${PERMISSIONS.join(', ')}.`, {
      field: 'scopes',
      unknown,
    });
  }
  const mine = effectivePermissions(ctx);
  const excess = (raw as Permission[]).filter((s) => !mine.includes(s));
  if (excess.length > 0) {
    throw new ApiError(
      'FORBIDDEN',
      `You cannot grant scope(s) you do not hold: ${excess.join(', ')}.`,
      'Ask an owner to create this key, or request a role that includes those permissions.',
      { excess, yours: mine },
    );
  }
  return [...new Set(raw as Permission[])];
}

async function list(ctx: Ctx) {
  const rows = await orgTx(ctx, (tx) =>
    tx.query<KeyRow>('select * from api_keys where org_id = $1 order by created_at desc', [ctx.principal.orgId]),
  );
  return ok({ apiKeys: rows.map(view) });
}

async function create(ctx: Ctx) {
  const name = requireString(ctx.body, 'name', { max: 80 });
  const scopes = requireScopes(ctx);

  const expiresInDays = ctx.body['expiresInDays'];
  let expiresAt: string | null = null;
  if (expiresInDays !== undefined && expiresInDays !== null) {
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 730) {
      throw invalid('expiresInDays must be a whole number between 1 and 730.', 'Omit it for a key that does not expire.', {
        field: 'expiresInDays',
      });
    }
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const { key, hash, prefix } = mintApiKey();

  const row = await orgTx(ctx, async (tx) => {
    const inserted = await tx.one<KeyRow>(
      `insert into api_keys (org_id, created_by, name, prefix, hashed_key, scopes, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [
        ctx.principal.orgId,
        ctx.principal.kind === 'session' ? ctx.principal.userId : null,
        name,
        prefix,
        hash,
        scopes,
        expiresAt,
      ],
    );
    await audit(tx, ctx.principal, {
      action: 'apikey.create',
      resourceType: 'api_key',
      resourceId: inserted!.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { name, scopes, expiresAt },
    });
    return inserted!;
  });

  return created({
    apiKey: view(row),
    // Shown once. Everything else about the key can be recovered; this cannot.
    secret: key,
    notice: 'Copy this key now. It is hashed at rest and cannot be shown again.',
  });
}

async function revoke(ctx: Ctx) {
  const id = ctx.params['id']!;
  await orgTx(ctx, async (tx) => {
    const existing = await tx.one<{ id: string; name: string; revoked_at: Date | null }>(
      'select id, name, revoked_at from api_keys where id = $1',
      [id],
    );
    if (!existing) throw notFound('API key');
    if (existing.revoked_at) {
      // Revocation is idempotent by nature; re-revoking is not an error worth raising.
      return;
    }
    await tx.query('update api_keys set revoked_at = now() where id = $1', [id]);
    await audit(tx, ctx.principal, {
      action: 'apikey.revoke',
      resourceType: 'api_key',
      resourceId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { name: existing.name },
    });
  });
  return noContent();
}

export const apiKeyRoutes: readonly Route[] = [
  { method: 'GET', path: '/v1/api-keys', doc: "List the organization's API keys. Secrets are never returned again after creation.", auth: 'apikey:read', handler: list },
  // Deliberately NOT idempotent: replaying a stored response would mean keeping the
  // plaintext key in idempotency_keys, undoing the point of hashing it at rest.
  // A duplicate key is a visible, revocable annoyance; a stored secret is not.
  { method: 'POST', path: '/v1/api-keys', doc: 'Issue an API key with a set of scopes. The secret is shown once, in this response.', auth: 'apikey:write', handler: create },
  { method: 'DELETE', path: '/v1/api-keys/:id', doc: 'Revoke an API key immediately.', auth: 'apikey:write', handler: revoke },
];
