/**
 * The error table is a published contract, so it is tested like one.
 *
 * Two things are pinned here. The first is internal consistency — a code whose status
 * contradicts its category, or a `retryable: true` on something no amount of retrying
 * will fix, is a bug that reaches clients as a retry storm or as a error surfaced to a
 * human who could have been spared it.
 *
 * The second is that `docs/api/errors.md` matches the table. Documentation that is
 * merely *intended* to match the code drifts within a release or two; this one fails
 * the build instead. Regenerate with `npm run docs:errors`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, ERROR_CODES, errorTable, type ErrorSpec } from '../src/errorcatalog.js';
import { ApiError } from '../src/errors.js';

const DOC_PATH = fileURLToPath(new URL('../../../docs/api/errors.md', import.meta.url));

const CATEGORY_TITLES: Record<ErrorSpec['category'], string> = {
  authentication: 'Authentication',
  authorization: 'Authorization',
  request: 'Request shape',
  policy: 'Policy',
  compilation: 'Compilation',
  server: 'Server',
};

const escape = (text: string) => text.replace(/\|/g, '\\|');

function renderReference(): string {
  const lines: string[] = [
    '# Error reference',
    '',
    '<!-- Generated from functions/api/src/errorcatalog.ts by `npm run docs:errors`. Do not edit by hand. -->',
    '',
    'Every failure returns the same envelope:',
    '',
    '```json',
    '{',
    '  "error": {',
    '    "code": "BUDGET_EXCEEDED",',
    '    "message": "What went wrong, in terms of your request.",',
    '    "hint": "What to do about it.",',
    '    "retryable": false,',
    '    "details": { "…": "code-specific, documented below where it matters" }',
    '  }',
    '}',
    '```',
    '',
    'Branch on `code`. It is stable; `message` and `hint` are prose and may be reworded.',
    '',
    '`retryable` answers one question: *could replaying this exact request succeed later?*',
    'It does not mean the failure was ours. A `429` is retryable, a `401` is not — the same',
    'credential will be refused the same way — and a `422` is not, because the request itself',
    'is what needs to change.',
    '',
    'The live table is served at `GET /v1/errors`, so a client library can generate its own',
    'enum and retry policy rather than keeping a copy that ages.',
    '',
  ];

  for (const category of Object.keys(CATEGORY_TITLES) as ErrorSpec['category'][]) {
    const rows = errorTable().filter((e) => e.category === category);
    if (rows.length === 0) continue;
    lines.push(`## ${CATEGORY_TITLES[category]}`, '');
    lines.push('| Code | HTTP | Retryable | Meaning | What to do |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of rows) {
      lines.push(
        `| \`${row.code}\` | ${row.status} | ${row.retryable ? 'yes' : 'no'} | ${escape(row.meaning)} | ${escape(row.resolution)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

describe('the error catalog', () => {
  it('gives every code a client-visible status and a resolution', () => {
    for (const code of ERROR_CODES) {
      const spec = ERROR_CATALOG[code];
      expect(spec.status, code).toBeGreaterThanOrEqual(400);
      expect(spec.status, code).toBeLessThan(600);
      // A hint that does not say what to do is a hint in name only.
      expect(spec.meaning.length, code).toBeGreaterThan(20);
      expect(spec.resolution.length, code).toBeGreaterThan(20);
    }
  });

  it('marks as retryable only what retrying can actually fix', () => {
    const retryable = ERROR_CODES.filter((code) => ERROR_CATALOG[code].retryable);
    // Anything else is a promise we cannot keep: the request would be refused
    // identically, and a client trusting the flag would loop.
    expect(retryable.sort()).toEqual(['IDEMPOTENT_REQUEST_IN_PROGRESS', 'INTERNAL', 'RATE_LIMITED']);
  });

  it('is the single source of the status an ApiError carries', () => {
    for (const code of ERROR_CODES) {
      const err = new ApiError(code, 'message', 'hint');
      expect(err.status, code).toBe(ERROR_CATALOG[code].status);
      expect(err.retryable, code).toBe(ERROR_CATALOG[code].retryable);
      expect(err.toBody().error.retryable, code).toBe(ERROR_CATALOG[code].retryable);
    }
  });

  it('matches the published reference', () => {
    const rendered = renderReference();
    if (process.env['UPDATE_DOCS']) {
      writeFileSync(DOC_PATH, rendered);
      return;
    }
    expect(
      readFileSync(DOC_PATH, 'utf8'),
      'docs/api/errors.md is out of date — run `npm run docs:errors`',
    ).toBe(rendered);
  });
});
