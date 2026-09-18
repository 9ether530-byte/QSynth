/**
 * Database access. `withTx` is the ONLY sanctioned query path for request handling.
 *
 * Every transaction it opens does two things before any statement runs:
 *   1. SET LOCAL ROLE qsynth_app — drops out of the platform's BYPASSRLS owner role
 *      into one that row level security actually applies to (see migration 002).
 *   2. set_config('app.current_org' / 'app.current_user') — the values every RLS
 *      policy reads. Unset means NULL means no rows match: fail-closed.
 *
 * Both are SET LOCAL / is_local=true, so they revert on COMMIT or ROLLBACK. That is
 * what makes this safe under connection pooling — a handler that throws cannot leave
 * a pooled connection carrying another tenant's context.
 *
 * Bypassing this helper with a raw pool.query() on a tenant table would run as the
 * owner and silently see every organization's data. Don't.
 */
import pg from 'pg';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: true },
      // Lambda concurrency is per-container; a small pool avoids exhausting Postgres
      // when many containers are warm.
      max: 3,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export interface TxContext {
  readonly orgId: string | null;
  readonly userId: string | null;
}

export interface Tx {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  one<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<R | undefined>;
  /** Runs `fn` in a savepoint; on error rolls back to it and rethrows, leaving the outer tx usable. */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
}

let savepointSeq = 0;

export async function withTx<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role qsynth_app');
    await client.query('select set_config($1, $2, true), set_config($3, $4, true)', [
      'app.current_org',
      ctx.orgId ?? '',
      'app.current_user',
      ctx.userId ?? '',
    ]);

    const tx: Tx = {
      async query(sql, params) {
        const r = await client.query(sql, params as never[]);
        return r.rows as never;
      },
      async one(sql, params) {
        const r = await client.query(sql, params as never[]);
        return r.rows[0] as never;
      },
      async savepoint(inner) {
        const name = `sp_${++savepointSeq}`;
        await client.query(`savepoint ${name}`);
        try {
          const result = await inner();
          await client.query(`release savepoint ${name}`);
          return result;
        } catch (err) {
          await client.query(`rollback to savepoint ${name}`);
          throw err;
        }
      },
    };

    const result = await fn(tx);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience for the authentication path, where no org is resolved yet. */
export const withAuthTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withTx({ orgId: null, userId: null }, fn);
