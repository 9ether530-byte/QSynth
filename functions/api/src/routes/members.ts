/**
 * Organization membership.
 *
 * Two invariants are enforced here rather than in the schema, because both need to
 * see the whole roster to decide:
 *   - an organization always keeps at least one owner (no self-lockout)
 *   - nobody may grant a role above their own (no privilege escalation sideways)
 */
import { audit } from '../auth.js';
import { ApiError, invalid, notFound } from '../errors.js';
import type { Role } from '../authz.js';
import { created, noContent, ok, orgTx, requireString, type Ctx, type Route } from '../router.js';
import { withAuthTx } from '../db.js';

const ROLES: readonly Role[] = ['owner', 'admin', 'developer', 'viewer'];
const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

function requireRole(body: Record<string, unknown>): Role {
  const value = body['role'];
  if (typeof value !== 'string' || !ROLES.includes(value as Role)) {
    throw invalid('A valid role is required.', `Use one of: ${ROLES.join(', ')}.`, { field: 'role', allowed: ROLES });
  }
  return value as Role;
}

/**
 * An API key has scopes, not a role, so it has no rank to compare against. Rather than
 * inventing one, key-authenticated callers are barred from changing roles at all —
 * membership is a human decision and a leaked key should not be able to make it.
 */
function assertCanGrant(ctx: Ctx, target: Role): void {
  if (ctx.principal.kind !== 'session') {
    throw new ApiError(
      'FORBIDDEN',
      'API keys cannot change organization membership.',
      'Perform membership changes from a signed-in session.',
    );
  }
  if (RANK[target] > RANK[ctx.principal.role]) {
    throw new ApiError(
      'FORBIDDEN',
      `You cannot grant the "${target}" role, which is above your own.`,
      'Ask an organization owner to make this change.',
      { yourRole: ctx.principal.role, requested: target },
    );
  }
}

interface MemberRow {
  user_id: string;
  role: Role;
  created_at: Date;
  email: string;
  name: string;
}

const view = (m: MemberRow) => ({
  userId: m.user_id,
  role: m.role,
  email: m.email,
  name: m.name,
  joinedAt: m.created_at,
});

const MEMBER_SELECT = `select m.user_id, m.role, m.created_at, u.email, u.name
                         from memberships m join users u on u.id = m.user_id
                        where m.org_id = $1`;
const ROSTER_SQL = `${MEMBER_SELECT} order by m.created_at`;
const ONE_MEMBER_SQL = `${MEMBER_SELECT} and m.user_id = $2`;

async function list(ctx: Ctx) {
  const rows = await orgTx(ctx, (tx) => tx.query<MemberRow>(ROSTER_SQL, [ctx.principal.orgId]));
  return ok({ members: rows.map(view) });
}

async function add(ctx: Ctx) {
  const email = requireString(ctx.body, 'email', { max: 254 }).toLowerCase();
  const role = requireRole(ctx.body);
  assertCanGrant(ctx, role);

  const found = await withAuthTx((tx) =>
    tx.one<{ user_id: string; name: string }>('select * from find_user_for_invite($1)', [email]),
  );
  if (!found) {
    throw new ApiError(
      'NOT_FOUND',
      'No QSYNTH account exists for that email address.',
      'Ask them to register first, then add them. Email invitations are not available yet.',
      { email },
    );
  }

  const row = await orgTx(ctx, async (tx) => {
    const inserted = await tx.one<{ user_id: string }>(
      `insert into memberships (org_id, user_id, role) values ($1, $2, $3)
       on conflict (org_id, user_id) do nothing
       returning user_id`,
      [ctx.principal.orgId, found.user_id, role],
    );
    if (!inserted) {
      throw new ApiError('CONFLICT', 'That person is already a member of this organization.', 'Change their role instead.');
    }
    await audit(tx, ctx.principal, {
      action: 'member.add',
      resourceType: 'membership',
      resourceId: found.user_id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { role, email },
    });
    return tx.one<MemberRow>(ONE_MEMBER_SQL, [
      ctx.principal.orgId,
      found.user_id,
    ]);
  });

  return created({ member: view(row!) });
}

async function changeRole(ctx: Ctx) {
  const userId = ctx.params['userId']!;
  const role = requireRole(ctx.body);
  assertCanGrant(ctx, role);

  const row = await orgTx(ctx, async (tx) => {
    const existing = await tx.one<{ role: Role }>('select role from memberships where org_id = $1 and user_id = $2', [
      ctx.principal.orgId,
      userId,
    ]);
    if (!existing) throw notFound('Member');

    // Demoting an existing owner needs the same authority as granting the role you
    // are taking away, otherwise an admin could quietly remove every owner.
    assertCanGrant(ctx, existing.role);

    if (existing.role === 'owner' && role !== 'owner') {
      await assertNotLastOwner(tx, ctx.principal.orgId, userId);
    }

    await tx.query('update memberships set role = $3 where org_id = $1 and user_id = $2', [
      ctx.principal.orgId,
      userId,
      role,
    ]);
    await audit(tx, ctx.principal, {
      action: 'member.role_change',
      resourceType: 'membership',
      resourceId: userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { from: existing.role, to: role },
    });
    return tx.one<MemberRow>(ONE_MEMBER_SQL, [
      ctx.principal.orgId,
      userId,
    ]);
  });

  return ok({ member: view(row!) });
}

async function remove(ctx: Ctx) {
  const userId = ctx.params['userId']!;
  await orgTx(ctx, async (tx) => {
    const existing = await tx.one<{ role: Role }>('select role from memberships where org_id = $1 and user_id = $2', [
      ctx.principal.orgId,
      userId,
    ]);
    if (!existing) throw notFound('Member');
    assertCanGrant(ctx, existing.role);
    if (existing.role === 'owner') await assertNotLastOwner(tx, ctx.principal.orgId, userId);

    await tx.query('delete from memberships where org_id = $1 and user_id = $2', [ctx.principal.orgId, userId]);
    await audit(tx, ctx.principal, {
      action: 'member.remove',
      resourceType: 'membership',
      resourceId: userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { role: existing.role },
    });
  });
  return noContent();
}

async function assertNotLastOwner(
  tx: { one<R extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R | undefined> },
  orgId: string,
  excludingUserId: string,
): Promise<void> {
  const row = await tx.one<{ count: string }>(
    "select count(*)::text as count from memberships where org_id = $1 and role = 'owner' and user_id <> $2",
    [orgId, excludingUserId],
  );
  if (Number(row?.count ?? '0') === 0) {
    throw new ApiError(
      'CONFLICT',
      'This is the only owner of the organization.',
      'Promote another member to owner first, then retry.',
    );
  }
}

async function getOrganization(ctx: Ctx) {
  const row = await orgTx(ctx, (tx) =>
    tx.one<{ id: string; name: string; slug: string; plan: string; data_region: string; created_at: Date }>(
      'select id, name, slug, plan, data_region, created_at from organizations where id = $1',
      [ctx.principal.orgId],
    ),
  );
  if (!row) throw notFound('Organization');
  return ok({
    organization: { id: row.id, name: row.name, slug: row.slug, plan: row.plan, dataRegion: row.data_region, createdAt: row.created_at },
  });
}

async function updateOrganization(ctx: Ctx) {
  const name = requireString(ctx.body, 'name', { max: 120 });
  const row = await orgTx(ctx, async (tx) => {
    const updated = await tx.one<{ id: string; name: string; slug: string }>(
      'update organizations set name = $2 where id = $1 returning id, name, slug',
      [ctx.principal.orgId, name],
    );
    await audit(tx, ctx.principal, {
      action: 'organization.update',
      resourceType: 'organization',
      resourceId: ctx.principal.orgId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { name },
    });
    return updated!;
  });
  return ok({ organization: row });
}

export const memberRoutes: readonly Route[] = [
  { method: 'GET', path: '/v1/organization', doc: "Fetch the calling organization's name and settings.", auth: 'member:read', handler: getOrganization },
  { method: 'PATCH', path: '/v1/organization', doc: "Change the organization's name or settings.", auth: 'org:write', handler: updateOrganization },
  { method: 'GET', path: '/v1/members', doc: "List the organization's members and their roles.", auth: 'member:read', handler: list },
  { method: 'POST', path: '/v1/members', doc: 'Add an existing user to the organization with a role.', auth: 'member:write', handler: add },
  { method: 'PATCH', path: '/v1/members/:userId', doc: "Change a member's role.", auth: 'member:write', handler: changeRole },
  { method: 'DELETE', path: '/v1/members/:userId', doc: 'Remove a member from the organization.', auth: 'member:write', handler: remove },
];
