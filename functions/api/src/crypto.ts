/**
 * Password hashing, token minting, and constant-time comparison.
 * Uses only node:crypto — no dependency, nothing to keep patched.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (p: string | Buffer, s: string | Buffer, k: number) => Promise<Buffer>;

const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_LEN);
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const derived = await scrypt(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, 'hex');
  // timingSafeEqual throws on length mismatch, which would itself leak a signal.
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

/** SHA-256 hex. Used for the at-rest form of session tokens and API keys. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Opaque 256-bit session token. The database only ever sees its hash. */
export function mintSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

/**
 * API key. The prefix is stored in clear for display ("qs_live_a1b2…") so users can
 * tell keys apart in a list; it is far too short to be useful for authentication.
 */
export function mintApiKey(): { key: string; hash: string; prefix: string } {
  const key = `qs_live_${randomBytes(30).toString('base64url')}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 16) };
}
