/**
 * Audit log reads. The table has no UPDATE or DELETE policy and the application role
 * holds no such grant, so this is the only way the records are ever touched again.
 *
 * Paging is keyset-based on the bigserial id rather than OFFSET: the log is append-only
 * and high-volume, so a page boundary must not shift while someone is reading through it.
 */
import { ok, orgTx, type Ctx, type Route } from '../router.js';

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  ts: Date;
}

async function list(ctx: Ctx) {
  const limit = Math.min(Math.max(Number(ctx.query.get('limit') ?? 100) || 100, 1), 500);
  const before = ctx.query.get('before');
  const action = ctx.query.get('action');

  const rows = await orgTx(ctx, (tx) =>
    tx.query<AuditRow>(
      `select a.id::text, a.actor_user_id, a.actor_api_key_id, u.name as actor_name, u.email as actor_email,
              a.action, a.resource_type, a.resource_id, a.ip, a.user_agent, a.metadata, a.ts
         from audit_logs a
         left join users u on u.id = a.actor_user_id
        where a.org_id = $1
          and ($2::bigint is null or a.id < $2::bigint)
          and ($3::text is null or a.action = $3)
        order by a.id desc
        limit $4`,
      [ctx.principal.orgId, before, action, limit],
    ),
  );

  return ok({
    entries: rows.map((r) => ({
      id: r.id,
      at: r.ts,
      action: r.action,
      actor: r.actor_user_id
        ? { kind: 'user', id: r.actor_user_id, name: r.actor_name, email: r.actor_email }
        : r.actor_api_key_id
          ? { kind: 'api_key', id: r.actor_api_key_id }
          : { kind: 'system' },
      resource: { type: r.resource_type, id: r.resource_id },
      ip: r.ip,
      userAgent: r.user_agent,
      metadata: r.metadata,
    })),
    // Absent when the page was not full — there is nothing further back to fetch.
    nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null,
  });
}

export const auditRoutes: readonly Route[] = [
  { method: 'GET', path: '/v1/audit-logs', auth: 'audit:read', handler: list },
];
