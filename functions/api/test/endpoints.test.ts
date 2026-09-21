/**
 * The endpoint reference is generated from the route table, not written alongside it.
 *
 * A reference maintained by hand describes the API somebody meant to ship. This one
 * cannot: `doc` is a required field on `Route`, so an undocumented endpoint is a type
 * error, and this test fails the build if the committed markdown has drifted from the
 * table it was generated from. Regenerate with `npm run docs:endpoints`.
 *
 * The role column is derived from ROLE_PERMISSIONS rather than restated, for the same
 * reason: the matrix in the docs and the matrix that is enforced are one object.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/handler.js';
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from '../src/authz.js';
import { LIMITS } from '../src/ratelimit.js';

const DOC_PATH = fileURLToPath(new URL('../../../docs/api/endpoints.md', import.meta.url));

const ROLES: Role[] = ['viewer', 'developer', 'admin', 'owner'];

/** The lowest role that can reach a route, or a plain description when no role applies. */
function reach(auth: string): string {
  if (auth === 'public') return 'anyone';
  if (auth === 'authenticated') return 'any member';
  const lowest = ROLES.find((role) => ROLE_PERMISSIONS[role].includes(auth as Permission));
  return lowest ? `${lowest}+` : '**unreachable**';
}

const GROUPS: Array<{ title: string; prefix: string }> = [
  { title: 'Service', prefix: '/v1/health' },
  { title: 'Authentication', prefix: '/v1/auth' },
  { title: 'Projects', prefix: '/v1/projects' },
  { title: 'Compilation', prefix: '/v1/compile' },
  { title: 'Artifacts', prefix: '/v1/artifacts' },
  { title: 'Organization and members', prefix: '/v1/member' },
  { title: 'API keys', prefix: '/v1/api-keys' },
  { title: 'Audit', prefix: '/v1/audit' },
];

function groupOf(path: string): string {
  if (path === '/v1/health' || path === '/v1/errors') return 'Service';
  if (path === '/v1/organization') return 'Organization and members';
  return GROUPS.find((g) => path.startsWith(g.prefix))?.title ?? 'Other';
}

function renderReference(): string {
  const lines: string[] = [
    '# Endpoint reference',
    '',
    '<!-- Generated from the route table by `npm run docs:endpoints`. Do not edit by hand. -->',
    '',
    'Base URL: the API Function URL, or `/api` on the site distribution — both serve the',
    'same routes, so `/v1/compile` and `/api/v1/compile` are the same endpoint.',
    '',
    '## Authenticating',
    '',
    'Send `Authorization: Bearer <token>`, where the token is either a session token from',
    '`POST /v1/auth/login` or an API key secret. A session token that belongs to more than',
    'one organization must also send `X-Org-Id`; without it the request is refused with',
    '`NO_ORG_CONTEXT` rather than guessed at.',
    '',
    'An API key carries explicit scopes instead of a role. Its permissions are exactly the',
    'scopes it was issued with — it cannot exceed them no matter who created it, and it is',
    "unaffected by later changes to that person's role.",
    '',
    '## Reading the columns',
    '',
    '- **Reach** — the lowest role that can call it. `developer+` means developer, admin and',
    '  owner; a viewer is refused with `FORBIDDEN`.',
    '- **Scope** — the permission an API key must hold. The same string as the role',
    '  permission, so a key is granted precisely what a role would allow.',
    '- **Idem.** — honours `Idempotency-Key`. Replaying a key returns the stored response',
    '  with `Idempotency-Replayed: true` instead of doing the work twice.',
    '',
    'Every authenticated response carries `RateLimit-Limit`, `RateLimit-Remaining` and',
    `\`RateLimit-Reset\`. The default budget is ${LIMITS['default']('x').perMinute} requests/minute per principal; routes marked`,
    `\`compile\` below are metered separately at ${LIMITS['compile']('x').perMinute}/minute, because they cost real compute.`,
    '',
    'Routes marked `n/a` are public: there is no principal to meter, so they send no',
    'RateLimit headers. They are not unlimited — `register` is throttled per client IP and',
    '`login` per account *and* per client IP, so guessing one password many times and one',
    'password against many accounts are both expensive. Both answer `429 RATE_LIMITED`.',
    '',
    'Failures use one envelope, documented in [errors.md](./errors.md).',
    '',
  ];

  const seen = new Set<string>();
  for (const { title } of [...GROUPS, { title: 'Other' }]) {
    if (seen.has(title)) continue;
    seen.add(title);
    const rows = ROUTES.filter((r) => groupOf(r.path) === title);
    if (rows.length === 0) continue;

    lines.push(`## ${title}`, '');
    lines.push('| Endpoint | Reach | Scope | Limit | Idem. | Description |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const route of rows) {
      const scope = PERMISSIONS.includes(route.auth as Permission) ? `\`${route.auth}\`` : '—';
      const idempotent = 'idempotent' in route && route.idempotent ? 'yes' : '—';
      // A public route returns before the per-principal limiter runs — there is no
      // principal to meter. Printing "default" there would promise a budget and a set
      // of RateLimit headers that this endpoint does not actually send.
      const limit = route.auth === 'public' ? 'n/a' : (route.rateLimit ?? 'default');
      lines.push(
        `| \`${route.method} ${route.path}\` | ${reach(route.auth)} | ${scope} | ` +
          `${limit} | ${idempotent} | ${route.doc} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## The export gate',
    '',
    '`GET /v1/artifacts/:id` is the one endpoint whose refusal is not about the caller.',
    'Before returning bytes it looks up the stored verification report for those exact',
    'bytes; with no passing report it answers `403 VERIFICATION_REQUIRED`. An owner with a',
    'valid key gets the same refusal as everyone else, because the check is on the artifact.',
    '',
  );

  return lines.join('\n');
}

describe('the endpoint reference', () => {
  it('documents every route in the caller’s terms', () => {
    for (const route of ROUTES) {
      const id = `${route.method} ${route.path}`;
      expect(route.doc, id).toBeTruthy();
      // A description shorter than this is a restatement of the path, which the reader
      // already has in the next column over.
      expect(route.doc.length, id).toBeGreaterThan(20);
      expect(route.doc.endsWith('.'), id).toBe(true);
    }
  });

  it('leaves no route unreachable by any role', () => {
    // A permission no role holds is a route nobody can call — deny-by-default working
    // exactly as designed, and almost certainly not what was intended.
    for (const route of ROUTES) {
      expect(reach(route.auth), `${route.method} ${route.path}`).not.toBe('**unreachable**');
    }
  });

  it('files every route under a named group', () => {
    // 'Other' is the fallback, and a route landing there means a new area of the API was
    // added without deciding where a reader should look for it.
    for (const route of ROUTES) {
      expect(groupOf(route.path), `${route.method} ${route.path}`).not.toBe('Other');
    }
  });

  it('declares no duplicate method and path', () => {
    // Two matching entries would mean the second is dead code: dispatch takes the first.
    const ids = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the published reference', () => {
    const rendered = renderReference();
    if (process.env['UPDATE_DOCS']) {
      writeFileSync(DOC_PATH, rendered);
      return;
    }
    expect(
      readFileSync(DOC_PATH, 'utf8'),
      'docs/api/endpoints.md is out of date — run `npm run docs:endpoints`',
    ).toBe(rendered);
  });
});
