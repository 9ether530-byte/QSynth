/**
 * Idempotency-Key handling for state-mutating POSTs.
 *
 * Three outcomes for a repeated key:
 *   - same key, same request body  → replay the stored response verbatim
 *   - same key, different body     → 422. Reusing a key for a different request is a
 *                                    client bug, and silently treating it as new would
 *                                    defeat the guarantee the header exists to provide.
 *   - same key, still in flight    → 409, retry shortly
 *
 * The reservation commits in its own transaction before the work starts, so a
 * concurrent duplicate sees `in_progress` rather than both proceeding.
 */
import { withTx } from './db.js';
import { ApiError } from './errors.js';
import { sha256 } from './crypto.js';

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type IdempotencyOutcome =
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'proceed'; commit: (response: StoredResponse) => Promise<void> };

export async function beginIdempotent(
  orgId: string,
  key: string,
  requestBody: unknown,
): Promise<IdempotencyOutcome> {
  const requestHash = sha256(JSON.stringify(requestBody ?? null));

  const existing = await withTx({ orgId, userId: null }, async (tx) => {
    const inserted = await tx.one<{ inserted: boolean }>(
      `insert into idempotency_keys (org_id, key, request_hash, state)
       values ($1, $2, $3, 'in_progress')
       on conflict (org_id, key) do nothing
       returning true as inserted`,
      [orgId, key, requestHash],
    );
    if (inserted) return null;

    return tx.one<{ request_hash: string; state: string; response_status: number | null; response_body: unknown }>(
      'select request_hash, state, response_status, response_body from idempotency_keys where org_id = $1 and key = $2',
      [orgId, key],
    );
  });

  if (!existing) {
    return {
      kind: 'proceed',
      commit: async (response) => {
        await withTx({ orgId, userId: null }, async (tx) => {
          await tx.query(
            `update idempotency_keys
                set state = 'complete', response_status = $3, response_body = $4
              where org_id = $1 and key = $2`,
            [orgId, key, response.status, JSON.stringify(response.body)],
          );
        });
      },
    };
  }

  if (existing.request_hash !== requestHash) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a request with a different body.',
      'Use a fresh Idempotency-Key for each distinct request.',
    );
  }

  if (existing.state !== 'complete') {
    throw new ApiError(
      'IDEMPOTENT_REQUEST_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed.',
      'Retry in a few seconds to receive the original response.',
      { retryAfter: 2 },
    );
  }

  return {
    kind: 'replay',
    response: { status: existing.response_status ?? 200, body: existing.response_body },
  };
}

/**
 * A request that failed releases its reservation, so the client can retry the same
 * key. Holding it would turn a transient failure into a permanently poisoned key.
 */
export async function releaseIdempotent(orgId: string, key: string): Promise<void> {
  try {
    await withTx({ orgId, userId: null }, async (tx) => {
      await tx.query("delete from idempotency_keys where org_id = $1 and key = $2 and state = 'in_progress'", [orgId, key]);
    });
  } catch {
    // Best effort; the reservation expires with the row's usefulness.
  }
}
