/**
 * Projects. Every query here runs through `orgTx`, so isolation is enforced by RLS
 * rather than by remembering to add `and org_id = $1` — a missing clause returns zero
 * rows instead of another tenant's data.
 */
import { audit } from '../auth.js';
import { notFound } from '../errors.js';
import { created, noContent, ok, optionalString, orgTx, requireString, type Ctx, type Route } from '../router.js';

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

const view = (p: ProjectRow) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  createdBy: p.created_by,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
  archived: p.archived_at !== null,
});

async function list(ctx: Ctx) {
  const includeArchived = ctx.query.get('archived') === 'true';
  const limit = Math.min(Number(ctx.query.get('limit') ?? 50) || 50, 200);
  const rows = await orgTx(ctx, (tx) =>
    tx.query<ProjectRow>(
      `select * from projects
        where ($1::boolean or archived_at is null)
        order by created_at desc
        limit $2`,
      [includeArchived, limit],
    ),
  );
  return ok({ projects: rows.map(view) });
}

async function create(ctx: Ctx) {
  const name = requireString(ctx.body, 'name', { max: 120 });
  const description = optionalString(ctx.body, 'description');

  const row = await orgTx(ctx, async (tx) => {
    const project = await tx.one<ProjectRow>(
      `insert into projects (org_id, name, description, created_by)
       values ($1, $2, $3, $4) returning *`,
      [ctx.principal.orgId, name, description, ctx.principal.kind === 'session' ? ctx.principal.userId : null],
    );
    await audit(tx, ctx.principal, {
      action: 'project.create',
      resourceType: 'project',
      resourceId: project!.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { name },
    });
    return project!;
  });

  return created({ project: view(row) });
}

async function get(ctx: Ctx) {
  const row = await orgTx(ctx, (tx) => tx.one<ProjectRow>('select * from projects where id = $1', [ctx.params['id']]));
  if (!row) throw notFound('Project');
  return ok({ project: view(row) });
}

async function update(ctx: Ctx) {
  const id = ctx.params['id'];
  const row = await orgTx(ctx, async (tx) => {
    const existing = await tx.one<ProjectRow>('select * from projects where id = $1', [id]);
    if (!existing) throw notFound('Project');

    const name = 'name' in ctx.body ? requireString(ctx.body, 'name', { max: 120 }) : existing.name;
    const description = 'description' in ctx.body ? optionalString(ctx.body, 'description') : existing.description;
    const archived =
      'archived' in ctx.body ? Boolean(ctx.body['archived']) : existing.archived_at !== null;

    const updated = await tx.one<ProjectRow>(
      `update projects
          set name = $2, description = $3,
              archived_at = case when $4 then coalesce(archived_at, now()) else null end,
              updated_at = now()
        where id = $1 returning *`,
      [id, name, description, archived],
    );
    await audit(tx, ctx.principal, {
      action: 'project.update',
      resourceType: 'project',
      resourceId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { name, archived },
    });
    return updated!;
  });
  return ok({ project: view(row) });
}

/**
 * Hard delete. Compile jobs, specs, artifacts and versions cascade — a project that
 * is only archived remains listable, so "delete" here has to mean what it says.
 */
async function destroy(ctx: Ctx) {
  const id = ctx.params['id'];
  await orgTx(ctx, async (tx) => {
    const existing = await tx.one<{ id: string; name: string }>('select id, name from projects where id = $1', [id]);
    if (!existing) throw notFound('Project');
    await tx.query('delete from projects where id = $1', [id]);
    await audit(tx, ctx.principal, {
      action: 'project.delete',
      resourceType: 'project',
      resourceId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { name: existing.name },
    });
  });
  return noContent();
}

export const projectRoutes: readonly Route[] = [
  { method: 'GET', path: '/v1/projects', doc: 'List the projects in the organization.', auth: 'project:read', handler: list },
  { method: 'POST', path: '/v1/projects', doc: 'Create a project to hold specifications and their compile history.', auth: 'project:write', idempotent: true, handler: create },
  { method: 'GET', path: '/v1/projects/:id', doc: 'Fetch one project: its name, description, owner and archived state.', auth: 'project:read', handler: get },
  { method: 'PATCH', path: '/v1/projects/:id', doc: 'Rename a project, change its description, or archive and unarchive it.', auth: 'project:write', handler: update },
  { method: 'DELETE', path: '/v1/projects/:id', doc: 'Delete a project and everything compiled under it.', auth: 'project:delete', handler: destroy },
];
