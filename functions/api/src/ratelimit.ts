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

/**
 * What the caller is told on every response, not only on the one that is refused.
 *
 * A limit a client can only discover by hitting it is a limit clients hit. These are
 * the IETF draft `RateLimit-*` fields; `reset` is seconds remaining in the window
 * rather than a timestamp, so it needs no clock agreement between us and the caller.
 */
export interface RateLimitState {
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
}

export function rateLimitHeaders(state: RateLimitState): Record<string, string> {
  return {
    'ratelimit-limit': String(state.limit),
    'ratelimit-remaining': String(state.remaining),
    'ratelimit-reset': String(state.reset),
  };
}

export async function enforceRateLimit(tx: Tx, orgId: string, limit: Limit): Promise<RateLimitState> {
  const row = await tx.one<{ count: number; window_start: Date }>(
    `insert into rate_limit_buckets (org_id, subject, window_start, count)
     values ($1, $2, to_timestamp(floor(extract(epoch from now()) / $3) * $3), 1)
     on conflict (org_id, subject, window_start)
       do update set count = rate_limit_buckets.count + 1
     returning count, window_start`,
    [orgId, limit.subject, WINDOW_SECONDS],
  );

  // A failed insert (the row is null only if the statement returned nothing) must not
  // be read as "zero used": reporting the full allowance would be a lie in the one
  // direction that hurts, so the conservative reading is used instead.
  const used = row?.count ?? limit.perMinute;
  const windowStart = row?.window_start ?? new Date();
  const resetAt = new Date(windowStart.getTime() + WINDOW_SECONDS * 1000);
  const reset = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));

  if (used > limit.perMinute) {
    throw new ApiError(
      'RATE_LIMITED',
      `Rate limit of ${limit.perMinute} requests per minute exceeded.`,
      `Wait ${reset}s before retrying, or spread requests more evenly.`,
      { retryAfter: reset, limit: limit.perMinute, remaining: 0, reset },
    );
  }

  return { limit: limit.perMinute, remaining: Math.max(0, limit.perMinute - used), reset };
}

/** Old windows are never read again; pruned opportunistically to bound table growth. */
export async function pruneRateLimits(tx: Tx): Promise<void> {
  await tx.query("delete from rate_limit_buckets where window_start < now() - interval '1 hour'");
}
