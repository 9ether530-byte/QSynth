/**
 * Row level security, asserted directly against the database as the application role.
 *
 * The HTTP tests prove the API does not hand over another tenant's data. This proves
 * the layer beneath: that even a handler with a missing `where org_id = ...` clause —
 * or an outright SQL injection — cannot reach across tenants, because the database
 * itself refuses.
 *
 * It must run as `qsynth_app`. The platform's connection role has BYPASSRLS, so a test
 * that forgot `SET LOCAL ROLE` would pass while proving nothing; the first assertion
 * here is therefore that the role switch actually happened.
 *
 * Requires DATABASE_URL (`openkbs postgres connection`); skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const CONNECTION = process.env['DATABASE_URL'];
const suite = CONNECTION ? describe : describe.skip;

let pool: pg.Pool;
const org: Record<'a' | 'b', { orgId: string; userId: string; projectId: string }> = {} as never;

/** Runs `fn` with the app role and an org context, exactly as the API does. */
async function asApp<T>(
  ctx: { orgId: string | null; userId: string | null },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role qsynth_app');
    await client.query('select set_config($1, $2, true), set_config($3, $4, true)', [
      'app.current_org',
      ctx.orgId ?? '',
      'app.current_user',
      ctx.userId ?? '',
    ]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Expects `fn` to be refused, isolating it in a savepoint so the tx stays usable. */
async function refused(client: pg.PoolClient, fn: () => Promise<unknown>): Promise<string> {
  await client.query('savepoint probe');
  try {
    await fn();
    await client.query('release savepoint probe');
    return 'ALLOWED';
  } catch (err) {
    await client.query('rollback to savepoint probe');
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

suite('row level security', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: CONNECTION, ssl: { rejectUnauthorized: true }, max: 2 });

    // Fixtures are created as the owner role, which bypasses RLS — that is the point:
    // the data exists, and the question is whether the app role can reach it.
    for (const key of ['a', 'b'] as const) {
      const user = await pool.query(
        `insert into users (email, name, password_hash, password_salt)
         values ($1, $2, 'x', 'y') returning id`,
        [`rls-${key}-${Date.now()}@qsynth-test.invalid`, `RLS ${key}`],
      );
      const orgRow = await pool.query('insert into organizations (name, slug) values ($1, $2) returning id', [
        `RLS org ${key}`,
        `rls-org-${key}-${Date.now()}`,
      ]);
      await pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
        orgRow.rows[0].id,
        user.rows[0].id,
      ]);
      const project = await pool.query('insert into projects (org_id, name) values ($1, $2) returning id', [
        orgRow.rows[0].id,
        `RLS project ${key}`,
      ]);
      org[key] = { orgId: orgRow.rows[0].id, userId: user.rows[0].id, projectId: project.rows[0].id };
    }
  });

  afterAll(async () => {
    if (!pool) return;
    for (const key of ['a', 'b'] as const) {
      if (org[key]) await pool.query('delete from organizations where id = $1', [org[key].orgId]);
      if (org[key]) await pool.query('delete from users where id = $1', [org[key].userId]);
    }
    await pool.end();
  });

  it('actually runs as a role that RLS applies to', async () => {
    const row = await asApp({ orgId: org.a.orgId, userId: org.a.userId }, async (c) => {
      const r = await c.query('select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypass');
      return r.rows[0];
    });
    expect(row.current_user).toBe('qsynth_app');
    expect(row.bypass).toBe(false);
  });

  it('sees only its own org\'s projects, even with no where clause', async () => {
    const ids = await asApp({ orgId: org.a.orgId, userId: org.a.userId }, async (c) => {
      const r = await c.query('select id from projects');
      return r.rows.map((x) => x.id);
    });
    expect(ids).toContain(org.a.projectId);
    expect(ids).not.toContain(org.b.projectId);
  });

  it('returns nothing for a targeted read of another org\'s row', async () => {
    const rows = await asApp({ orgId: org.a.orgId, userId: org.a.userId }, async (c) => {
      const r = await c.query('select id from projects where id = $1', [org.b.projectId]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('silently affects zero rows on a cross-org update or delete', async () => {
    const counts = await asApp({ orgId: org.a.orgId, userId: org.a.userId }, async (c) => {
      const upd = await c.query('update projects set name = $2 where id = $1', [org.b.projectId, 'hijacked']);
      const del = await c.query('delete from projects where id = $1', [org.b.projectId]);
      return { updated: upd.rowCount, deleted: del.rowCount };
    });
    expect(counts).toEqual({ updated: 0, deleted: 0 });

    const survivor = await pool.query('select name from projects where id = $1', [org.b.projectId]);
    expect(survivor.rows[0].name).toBe('RLS project b');
  });

  it('refuses an insert carrying another org\'s id', async () => {
    const code = await asApp({ orgId: org.a.orgId, userId: org.a.userId }, (c) =>
      refused(c, () => c.query('insert into projects (org_id, name) values ($1, $2)', [org.b.orgId, 'smuggled'])),
    );
    expect(code).toBe('42501');
  });

  it('refuses to update or delete audit records at all', async () => {
    await asApp({ orgId: org.a.orgId, userId: org.a.userId }, async (c) => {
      await c.query(
        `insert into audit_logs (org_id, action, resource_type) values ($1, 'rls.probe', 'test')`,
        [org.a.orgId],
      );
      expect(await refused(c, () => c.query("update audit_logs set action = 'tampered' where org_id = $1", [org.a.orgId]))).toBe('42501');
      expect(await refused(c, () => c.query('delete from audit_logs where org_id = $1', [org.a.orgId]))).toBe('42501');
    });
  });

  it('fails closed when no org context is set', async () => {
    const count = await asApp({ orgId: null, userId: null }, async (c) => {
      const r = await c.query('select count(*)::int as n from projects');
      return r.rows[0].n;
    });
    expect(count).toBe(0);
  });

  /**
   * The check that keeps working as the schema grows. Every one of the tests above
   * names a table by hand, so a table added in a later phase without a policy would
   * pass all of them. This one asks the catalog instead: carrying `org_id` is the
   * definition of tenant data, and tenant data without FORCE and a policy is a leak
   * waiting for the first handler that forgets a where clause.
   */
  it('has FORCE row level security and a policy on every table carrying org_id', async () => {
    const gaps = await pool.query(`
      select c.relname,
             c.relrowsecurity as enabled,
             c.relforcerowsecurity as forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and exists (
           select 1 from information_schema.columns col
            where col.table_schema = 'public' and col.table_name = c.relname
              and col.column_name = 'org_id')
         and not (c.relrowsecurity and c.relforcerowsecurity and
                  exists (select 1 from pg_policy p where p.polrelid = c.oid))
       order by c.relname`);
    expect(gaps.rows).toEqual([]);
  });

  it('hides another org\'s compilation history, reports and artifacts', async () => {
    // Written as the owner role so the rows genuinely exist; the question is reachability.
    const spec = await pool.query(
      `insert into specs (org_id, project_id, name, kind, source, content_hash)
       values ($1, $2, 'rls secret', 'boolean', 'out = a AND b', 'rls-probe-hash') returning id`,
      [org.b.orgId, org.b.projectId],
    );
    const job = await pool.query(
      `insert into compile_jobs (org_id, project_id, spec_id, spec_hash, status, seed, compiler_version)
       values ($1, $2, $3, 'rls-probe-hash', 'succeeded', 1, 'test') returning id`,
      [org.b.orgId, org.b.projectId, spec.rows[0].id],
    );
    const artifact = await pool.query(
      `insert into artifacts (org_id, kind, content_hash, storage_uri, size_bytes)
       values ($1, 'qasm3', 'rls-probe-artifact', 's3://nowhere/rls', 1) returning id`,
      [org.b.orgId],
    );
    await pool.query(
      `insert into verification_reports (org_id, job_id, passed, method, seed, checks)
       values ($1, $2, true, 'exhaustive', 1, '[]'::jsonb)`,
      [org.b.orgId, job.rows[0].id],
    );

    const seen = await asApp({ orgId: org.a.orgId, userId: org.a.userId }, async (c) => ({
      specs: (await c.query('select id from specs where id = $1', [spec.rows[0].id])).rowCount,
      jobs: (await c.query('select id from compile_jobs where id = $1', [job.rows[0].id])).rowCount,
      artifacts: (await c.query('select id from artifacts where id = $1', [artifact.rows[0].id])).rowCount,
      // The export gate reads this row. If RLS let it through, a passing verdict from
      // another tenant could authorize releasing an artifact.
      reports: (await c.query('select id from verification_reports where job_id = $1', [job.rows[0].id])).rowCount,
    }));
    expect(seen).toEqual({ specs: 0, jobs: 0, artifacts: 0, reports: 0 });
  });

  it('hides another org\'s users and organizations', async () => {
    const seen = await asApp({ orgId: org.a.orgId, userId: org.a.userId }, async (c) => {
      const users = await c.query('select id from users where id = $1', [org.b.userId]);
      const orgs = await c.query('select id from organizations where id = $1', [org.b.orgId]);
      return { users: users.rowCount, orgs: orgs.rowCount };
    });
    expect(seen).toEqual({ users: 0, orgs: 0 });
  });
});
