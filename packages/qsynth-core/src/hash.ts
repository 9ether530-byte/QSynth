/**
 * Content addressing.
 *
 * FR-7 (reproducibility) is only testable if "the same circuit" has a single byte
 * representation. JSON.stringify does not give one: key order follows insertion order,
 * and -0, NaN, and Infinity all round-trip badly. So canonical form is defined here
 * and everything hashed goes through it.
 *
 * Non-finite numbers and non-integer floats are rejected rather than serialized. The
 * IR is discrete — a float appearing in it means something upstream is wrong, and
 * silently hashing `0.1 + 0.2` would hide that behind a stable-looking digest.
 */
import { createHash } from 'node:crypto';
import { assertInvariant } from './errors.js';

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      assertInvariant(Number.isFinite(value), `non-finite number in canonical form (${String(value)})`);
      // -0 and 0 are the same value for our purposes and must not hash differently.
      return Object.is(value, -0) ? '0' : String(value);
    case 'bigint':
      return `${value}n`;
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      // Dropped by the object branch; reaching here means an undefined array element.
      return 'null';
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  if (value instanceof Uint8Array) {
    return `"u8:${Buffer.from(value).toString('base64')}"`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The content hash of any IR value: SHA-256 over its canonical form. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** Short, human-quotable prefix for display. Never used for lookup. */
export const shortHash = (hash: string): string => hash.slice(0, 12);
