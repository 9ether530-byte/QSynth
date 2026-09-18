/**
 * Fixed-window rate limiting in Postgres. The platform has no Redis, and a fixed
 * window in a table the request already has a transaction on is cheaper than adding
 * infrastructure for a v1 whose traffic is measured in compiles per minute.
 *
 * Known trade-off: a fixed window permits up to 2x the limit across a boundary. That
 * is acceptable here because the limit protects compute from runaway clients rather
 * than enforcing a billing quota. A sliding window is the upgrade path if it ever
 * needs to be exact.
 */
import type { Tx } from './db.js';
import { ApiError } from './errors.js';

const WINDOW_SECONDS = 60;

export interface Limit {
  readonly subject: string;
  readonly perMinute: number;
}

export const LIMITS = {
  default: (principal: string): Limit => ({ subject: `req:${principal}`, perMinute: 120 }),
  compile: (principal: string): Limit => ({ subject: `compile:${principal}`, perMinute: 20 }),
} as const;

export async function enforceRateLimit(tx: Tx, orgId: string, limit: Limit): Promise<void> {
  const row = await tx.one<{ count: number; window_start: Date }>(
    `insert into rate_limit_buckets (org_id, subject, window_start, count)
     values ($1, $2, to_timestamp(floor(extract(epoch from now()) / $3) * $3), 1)
     on conflict (org_id, subject, window_start)
       do update set count = rate_limit_buckets.count + 1
     returning count, window_start`,
    [orgId, limit.subject, WINDOW_SECONDS],
  );

  if (row && row.count > limit.perMinute) {
    const resetAt = new Date(row.window_start.getTime() + WINDOW_SECONDS * 1000);
    const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
    throw new ApiError(
      'RATE_LIMITED',
      `Rate limit of ${limit.perMinute} requests per minute exceeded.`,
      `Wait ${retryAfter}s before retrying, or spread requests more evenly.`,
      { retryAfter, limit: limit.perMinute },
    );
  }
}

/** Old windows are never read again; pruned opportunistically to bound table growth. */
export async function pruneRateLimits(tx: Tx): Promise<void> {
  await tx.query("delete from rate_limit_buckets where window_start < now() - interval '1 hour'");
}
