/**
 * Registration, login, logout, and "who am I".
 *
 * Login deliberately returns the same INVALID_CREDENTIALS error for an unknown email
 * and a wrong password, and runs a scrypt verification against a dummy hash when the
 * email is unknown, so the response time does not distinguish the two cases either.
 */
import { randomBytes } from 'node:crypto';
import { withAuthTx, withTx } from '../db.js';
import { hashPassword, verifyPassword, mintSessionToken, sha256 } from '../crypto.js';
import { ApiError, invalid } from '../errors.js';
import { audit } from '../auth.js';
import type { Role } from '../authz.js';
import { ROLE_PERMISSIONS } from '../authz.js';
import { created, ok, requireString, type Ctx, type PublicCtx, type Route } from '../router.js';

const SESSION_DAYS = 30;
const PASSWORD_MIN = 10;

/** A fixed hash+salt to verify against when the email is unknown, so timing matches. */
const DECOY = {
  hash: '0'.repeat(128),
  salt: 'qsynth-timing-decoy',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function requireEmail(body: Record<string, unknown>): string {
  const email = requireString(body, 'email', { max: 254 });
  if (!EMAIL_RE.test(email)) {
    throw invalid('That does not look like an email address.', 'Use the form name@example.com.', { field: 'email' });
  }
  return email.toLowerCase();
}

function requirePassword(body: Record<string, unknown>): string {
  const value = body['password'];
  if (typeof value !== 'string' || value.length < PASSWORD_MIN) {
    throw invalid(
      `A password of at least ${PASSWORD_MIN} characters is required.`,
      'Choose a longer password. Length protects far more than character classes do.',
      { field: 'password', minLength: PASSWORD_MIN },
    );
  }
  if (value.length > 512) {
    throw invalid('Password is too long.', 'Use at most 512 characters.', { field: 'password' });
  }
  return value;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

/**
 * Pre-auth throttling. Subject is hashed for login so the table never accumulates a
 * list of attempted addresses. Exceeding the window is a 429, not a silent delay —
 * a client that is being throttled deserves to know it.
 */
async function throttle(subject: string, limit: number, windowSeconds = 900): Promise<void> {
  const row = await withAuthTx((tx) =>
    tx.one<{ auth_throttle_hit: number }>('select auth_throttle_hit($1, $2)', [subject, windowSeconds]),
  );
  const count = row?.auth_throttle_hit ?? 0;
  if (count > limit) {
    throw new ApiError(
      'RATE_LIMITED',
      'Too many attempts. This address or address range is temporarily blocked.',
      `Wait up to ${Math.ceil(windowSeconds / 60)} minutes and try again.`,
      { retryAfter: windowSeconds },
    );
  }
}

interface SessionIssued {
  token: string;
  expiresAt: string;
}

async function issueSession(userId: string, ip: string | null, userAgent: string | null): Promise<SessionIssued> {
  const { token, hash } = mintSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await withAuthTx(async (tx) => {
    await tx.query('select create_session($1, $2, $3, $4, $5)', [userId, hash, expiresAt.toISOString(), userAgent, ip]);
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

async function register(ctx: PublicCtx) {
  // Generous per-IP ceiling. A tighter limit would block an office behind one NAT and
  // a CI suite creating fixtures, while doing little against an attacker with a
  // proxy pool — the thing this actually stops is single-host bulk signup.
  await throttle(`register:${ctx.ip ?? 'unknown'}`, 60, 3600);

  const email = requireEmail(ctx.body);
  const password = requirePassword(ctx.body);
  const name = requireString(ctx.body, 'name', { max: 120 });
  const orgName = requireString(ctx.body, 'organizationName', { max: 120 });

  const { hash, salt } = await hashPassword(password);

  // Slug collisions are resolved by suffixing rather than failing: an organization
  // name is a display choice, and refusing a signup because someone else picked the
  // same name would be a poor first impression.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? slugify(orgName) : `${slugify(orgName)}-${randomBytes(3).toString('hex')}`;
    try {
      const row = await withAuthTx((tx) =>
        tx.one<{ user_id: string; org_id: string }>('select * from register_user($1,$2,$3,$4,$5,$6)', [
          email,
          name,
          hash,
          salt,
          orgName,
          slug,
        ]),
      );
      if (!row) throw new ApiError('INTERNAL', 'Registration did not return an account.', 'Try again.');

      const session = await issueSession(row.user_id, ctx.ip, ctx.userAgent);
      await withTx({ orgId: row.org_id, userId: row.user_id }, (tx) =>
        audit(tx, { kind: 'session', userId: row.user_id, orgId: row.org_id, role: 'owner', sessionId: '' }, {
          action: 'auth.register',
          resourceType: 'user',
          resourceId: row.user_id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        }),
      );

      return created({
        token: session.token,
        expiresAt: session.expiresAt,
        user: { id: row.user_id, email, name },
        organization: { id: row.org_id, name: orgName, slug, role: 'owner' as Role },
      });
    } catch (err) {
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === 'users_email_lower_key') {
        // Not a leak worth avoiding: registration inherently reveals whether an email
        // is taken, since it cannot both succeed and not create the account.
        throw new ApiError(
          'CONFLICT',
          'An account already exists for that email address.',
          'Sign in instead, or use the password reset flow.',
          { field: 'email' },
        );
      }
      if (constraint === 'organizations_slug_key') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw new ApiError('CONFLICT', 'Could not allocate a unique organization slug.', 'Try a different organization name.', {
    cause: String(lastError),
  });
}

async function login(ctx: PublicCtx) {
  const email = requireEmail(ctx.body);
  const password = requireString(ctx.body, 'password', { max: 512 });

  await throttle(`login:${sha256(email)}`, 10);
  await throttle(`login-ip:${ctx.ip ?? 'unknown'}`, 50);

  const row = await withAuthTx((tx) =>
    tx.one<{ user_id: string; password_hash: string; password_salt: string; name: string }>(
      'select * from auth_user_by_email($1)',
      [email],
    ),
  );

  const okPassword = row
    ? await verifyPassword(password, row.password_hash, row.password_salt)
    : await verifyPassword(password, DECOY.hash, DECOY.salt);

  if (!row || !okPassword) {
    throw new ApiError(
      'INVALID_CREDENTIALS',
      'That email and password combination is not recognised.',
      'Check the address and password, or register a new account.',
    );
  }

  const session = await issueSession(row.user_id, ctx.ip, ctx.userAgent);

  const memberships = await withTx({ orgId: null, userId: row.user_id }, (tx) =>
    tx.query<{ org_id: string; role: Role; name: string; slug: string }>(
      `select m.org_id, m.role, o.name, o.slug
         from memberships m join organizations o on o.id = m.org_id
        where m.user_id = $1
        order by m.created_at`,
      [row.user_id],
    ),
  );

  await withTx({ orgId: null, userId: row.user_id }, async (tx) => {
    await tx.query('update users set last_login_at = now() where id = $1', [row.user_id]);
  });

  return ok({
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: row.user_id, email, name: row.name },
    organizations: memberships.map((m) => ({ id: m.org_id, name: m.name, slug: m.slug, role: m.role })),
  });
}

async function logout(ctx: Ctx) {
  if (ctx.principal.kind !== 'session') {
    throw invalid(
      'API keys do not have a session to end.',
      'Revoke the key under Settings → API keys instead.',
    );
  }
  const { userId, sessionId, orgId } = ctx.principal;
  await withTx({ orgId, userId }, async (tx) => {
    await tx.query('update sessions set revoked_at = now() where id = $1 and revoked_at is null', [sessionId]);
    await audit(tx, ctx.principal, { action: 'auth.logout', resourceType: 'session', resourceId: sessionId, ip: ctx.ip, userAgent: ctx.userAgent });
  });
  return ok({ ended: true });
}

async function me(ctx: Ctx) {
  if (ctx.principal.kind === 'api_key') {
    return ok({
      principal: 'api_key',
      organizationId: ctx.principal.orgId,
      scopes: ctx.principal.scopes,
    });
  }
  const { userId, orgId, role } = ctx.principal;
  const [user, memberships] = await withTx({ orgId, userId }, async (tx) => [
    await tx.one<{ id: string; email: string; name: string }>('select id, email, name from users where id = $1', [userId]),
    await tx.query<{ org_id: string; role: Role; name: string; slug: string }>(
      `select m.org_id, m.role, o.name, o.slug
         from memberships m join organizations o on o.id = m.org_id
        where m.user_id = $1 order by m.created_at`,
      [userId],
    ),
  ]);

  return ok({
    principal: 'session',
    user,
    activeOrganization: { id: orgId, role },
    permissions: ROLE_PERMISSIONS[role],
    organizations: memberships.map((m) => ({ id: m.org_id, name: m.name, slug: m.slug, role: m.role })),
  });
}

export const authRoutes: readonly Route[] = [
  { method: 'POST', path: '/v1/auth/register', doc: 'Create an account and its first organization, and return a session token.', auth: 'public', handler: register },
  { method: 'POST', path: '/v1/auth/login', doc: 'Exchange an email and password for a session token.', auth: 'public', handler: login },
  { method: 'POST', path: '/v1/auth/logout', doc: 'Revoke the session token used to make this request.', auth: 'authenticated', handler: logout },
  { method: 'GET', path: '/v1/auth/me', doc: "Describe the calling principal: a user with their organizations and roles, or an API key's scopes.", auth: 'authenticated', handler: me },
];
