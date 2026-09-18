/**
 * An axe pass over every route.
 *
 * What this catches is the mechanical half of accessibility: unlabelled controls, missing
 * table headers, a heading order that jumps, an input whose only label is a placeholder.
 * What it cannot catch is whether the interface is usable — colour contrast needs layout
 * jsdom does not do, and "can a screen-reader user understand why this circuit failed" is
 * not a rule in any linter. Those are covered by the keyboard pass in the manual checks
 * and by the text-equivalent gate list test in `circuit.test.tsx`.
 *
 * So: a clean run here is a floor, not a ceiling. It is still worth having, because every
 * violation it does find is one a real user would have hit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  const { apiStub } = await import('./stub');
  return { ...actual, api: apiStub };
});

const { apiStub, renderAt, signIn, signInWithoutOrg, signOut } = await import('./harness');
const { ApiError } = await import('../src/lib/api');

async function violations(): Promise<axe.Result[]> {
  const results = await axe.run(document.body, {
    // Layout-dependent rules cannot run in jsdom; asserting on them would assert on
    // nothing. Everything structural stays on.
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations;
}

function describeViolations(found: axe.Result[]): string {
  return found.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.html).join(' | ')})`).join('\n');
}

describe('accessibility', () => {
  beforeEach(() => {
    signIn();
  });

  it('has no violations on the sign-in page', async () => {
    signOut();
    renderAt('/signin');
    await screen.findByRole('heading', { name: 'QSYNTH' });
    const found = await violations();
    expect(describeViolations(found)).toBe('');
  });

  it('has no violations on the project list', async () => {
    renderAt('/');
    await screen.findByRole('link', { name: /Oracles/ });
    const found = await violations();
    expect(describeViolations(found)).toBe('');
  });

  it('has no violations on the workbench', async () => {
    renderAt('/p/p1');
    await screen.findByRole('heading', { name: 'Oracles' });
    const found = await violations();
    expect(describeViolations(found)).toBe('');
  });

  it('has no violations on the members page', async () => {
    renderAt('/settings/members');
    await screen.findByText('auditor@example.com');
    const found = await violations();
    expect(describeViolations(found)).toBe('');
  });

  it('has no violations on the API keys page', async () => {
    renderAt('/settings/keys');
    await screen.findByText('ci-pipeline');
    const found = await violations();
    expect(describeViolations(found)).toBe('');
  });

  it('has no violations on the audit log', async () => {
    renderAt('/settings/audit');
    await screen.findByText('compile.succeeded');
    const found = await violations();
    expect(describeViolations(found)).toBe('');
  });

  it('has no violations on the organization chooser', async () => {
    // The first screen an invited user ever sees, and the one route that is reached only
    // by an API refusal — easy to leave out of a sweep like this precisely because no
    // navigation leads to it.
    signInWithoutOrg();
    apiStub.me.mockRejectedValueOnce(
      new ApiError(400, 'NO_ORG_CONTEXT', 'Ambiguous.', 'Name one.', {
        organizations: [
          { id: 'o1', name: 'Acme Quantum', role: 'owner' },
          { id: 'o2', name: 'Hopper Review', role: 'viewer' },
        ],
      }),
    );
    renderAt('/');
    await screen.findByRole('heading', { name: 'Choose an organization' });
    const found = await violations();
    expect(describeViolations(found)).toBe('');
  });

  it('has no violations on the diff view', async () => {
    renderAt('/p/p1/diff/j0/j1');
    await screen.findByRole('heading', { name: 'Compare compiles' });
    // Both stubbed jobs carry the same circuit, so the gate panel settles on its
    // "nothing changed" state — which is the point to measure, since that is the state
    // with the resource table fully rendered.
    await waitFor(() => expect(screen.getByText('The gate lists are identical.')).toBeTruthy());
    const found = await violations();
    expect(describeViolations(found)).toBe('');
  });
});
