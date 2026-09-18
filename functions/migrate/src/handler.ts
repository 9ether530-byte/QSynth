/**
 * Forward-only migration runner. Invoke with:
 *   openkbs fn invoke migrate -d '{"action":"migrate"}'
 *   openkbs fn invoke migrate -d '{"action":"status"}'
 *
 * Each migration runs inside its own transaction and is recorded in
 * schema_migrations with a checksum. If a file already applied has since been
 * edited, the runner refuses to continue rather than silently diverging from
 * what is actually in the database.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { MIGRATIONS } from './generated/migrations.js';

interface LambdaEvent {
  readonly body?: string;
  readonly action?: string;
}

const LEDGER_SQL = `
  create table if not exists schema_migrations (
    name        text primary key,
    checksum    text not null,
    applied_at  timestamptz not null default now()
  )`;

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set — is postgres enabled in openkbs.json?');
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 1 });
  try {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function applied(client: pg.PoolClient): Promise<Map<string, string>> {
  await client.query(LEDGER_SQL);
  const { rows } = await client.query<{ name: string; checksum: string }>(
    'select name, checksum from schema_migrations',
  );
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function migrate() {
  return withClient(async (client) => {
    const have = await applied(client);
    const ran: string[] = [];

    for (const m of MIGRATIONS) {
      const sum = checksum(m.sql);
      const prior = have.get(m.name);

      if (prior !== undefined) {
        if (prior !== sum) {
          throw new Error(
            `Migration ${m.name} was already applied but its contents have changed. ` +
              `Migrations are forward-only: add a new file instead of editing this one.`,
          );
        }
        continue;
      }

      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          m.name,
          sum,
        ]);
        await client.query('commit');
        ran.push(m.name);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }

    return { applied: ran, alreadyApplied: MIGRATIONS.length - ran.length };
  });
}

async function status() {
  return withClient(async (client) => {
    const have = await applied(client);
    return {
      migrations: MIGRATIONS.map((m) => ({
        name: m.name,
        applied: have.has(m.name),
        drifted: have.has(m.name) && have.get(m.name) !== checksum(m.sql),
      })),
    };
  });
}

export const handler = async (event: LambdaEvent) => {
  const body = event.body ? JSON.parse(event.body) : event ?? {};
  const action = body.action ?? 'status';

  try {
    const result = action === 'migrate' ? await migrate() : await status();
    return { statusCode: 200, body: JSON.stringify({ ok: true, action, ...result }, null, 2) };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, action, error: (err as Error).message }, null, 2),
    };
  }
};
