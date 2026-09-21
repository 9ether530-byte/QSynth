/**
 * The example on the landing page, run against the deployed API.
 *
 * A marketing page is the one piece of documentation nobody regenerates, and the first
 * thing a new reader tries. Writing this example by hand produced two wrong fields on
 * the first pass — a budget key the API rejects outright, and an artifact `kind` that
 * does not exist — neither of which any other test in the repo could have noticed.
 *
 * So the request is not retyped here: it is parsed out of `site/index.html` and sent as
 * published. If someone edits the page and the API disagrees, this fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createTenant, unique, type Response, type Tenant } from './client.js';

const PAGE = readFileSync(fileURLToPath(new URL('../../site/index.html', import.meta.url)), 'utf8');

/** `&quot;` and friends — the page is HTML, the example inside it is not. */
const unescapeHtml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** The `-d '{ … }'` payload from the published curl invocation. */
function publishedRequest(): Record<string, unknown> {
  const match = /-d '(\{[\s\S]*?\})'/.exec(unescapeHtml(PAGE));
  if (!match) throw new Error('No curl -d payload found in site/index.html');
  return JSON.parse(match[1]!.replace(/"…"/g, '"00000000-0000-0000-0000-000000000000"'));
}

/**
 * The "What comes back" code block. Scoped to that block on purpose: the request
 * example above it also contains `"kind":`, and matching both would compare the
 * specification's kind (`boolean`) against the list of artifact kinds.
 */
function responseSnippet(): string {
  const snippet = /"What comes back"[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(
    unescapeHtml(PAGE.replace(/<h3[^>]*>([^<]*)<\/h3>/g, '"$1"')),
  );
  if (!snippet) throw new Error('No response snippet found in site/index.html');
  return snippet[1]!;
}

/** Every `"key":` that appears in the published response snippet, in order. */
const publishedResponseKeys = (): string[] =>
  [...responseSnippet().matchAll(/"([A-Za-z0-9_]+)":/g)].map((m) => m[1]!);

/** Collect every key name present anywhere in a response object. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

let tenant: Tenant;
let res: Response;

beforeAll(async () => {
  tenant = await createTenant('landing');
  const project = await call('POST', '/v1/projects', {
    auth: { token: tenant.token, orgId: tenant.orgId },
    body: { name: unique('landing-example') },
  });
  expect(project.status).toBe(201);

  // Compiled once, asserted from three angles below. The example costs real compute,
  // and running it three times would say nothing the first run did not.
  res = await call('POST', '/v1/compile', {
    auth: { token: tenant.token, orgId: tenant.orgId, idempotencyKey: crypto.randomUUID() },
    body: { ...publishedRequest(), projectId: project.body.project.id },
  });
}, 120_000);

describe('the example published on the landing page', () => {
  it('compiles and verifies exactly as written', () => {
    // A 4xx here means the page is telling readers to send a field the API refuses —
    // which is how the first draft of this page shipped `"qubits"` for `"maxQubits"`.
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.verification.passed).toBe(true);
    expect(res.body.verification.stoppedAt).toBeNull();

    // The page promises exhaustive coverage for a small spec. If the default ever became
    // sampling, the claim on the page would be false while every other test still passed.
    const equivalence = res.body.verification.checks.find(
      (c: { id: string }) => c.id === 'simulation_equivalence',
    );
    expect(equivalence.status).toBe('passed');
    expect(equivalence.coverage.mode).toBe('exhaustive');
    expect(equivalence.coverage.checked).toBe(equivalence.coverage.space);
  });

  it('describes the response with field names the response actually has', () => {
    const actual = keysOf(res.body);
    const published = publishedResponseKeys();
    expect(published.length).toBeGreaterThan(8);
    for (const key of published) {
      expect(actual.has(key), `the page shows "${key}", the response has no such field`).toBe(true);
    }
  });

  it('names only artifact kinds the compile really produces', () => {
    // `"kind": "qasm"` looked right and was wrong — the artifact is `qasm3`. A reader
    // filtering on the name printed here would have found nothing and had no idea why.
    const shown = [...responseSnippet().matchAll(/"kind": "([a-z0-9_]+)"/g)].map((m) => m[1]!);
    const produced = res.body.artifacts.map((a: { kind: string }) => a.kind);
    expect(shown.length).toBeGreaterThan(0);
    for (const kind of shown) {
      expect(produced, `the page names artifact kind "${kind}"`).toContain(kind);
    }
  });

  it('links only to endpoints that answer', async () => {
    // Every same-origin link on the page, checked against the deployed API. A dead link
    // in the footer of a landing page is the cheapest possible bug to have caught.
    const apiLinks = [...PAGE.matchAll(/href="(\/api\/[^"]+)"/g)].map((m) => m[1]!);
    expect(apiLinks.length).toBeGreaterThan(0);
    for (const link of apiLinks) {
      const res = await call('GET', link.replace(/^\/api/, ''));
      expect(res.status, link).toBe(200);
    }
  }, 60_000);
});
