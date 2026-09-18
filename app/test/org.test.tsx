/**
 * Belonging to two organizations must not lock you out.
 *
 * This is a regression test with a specific history. The members page invites someone by
 * email; if they already have an account, they now belong to two organizations — their
 * own and yours. The API refuses to guess which one a request means and answers
 * `NO_ORG_CONTEXT`, which is right. The workbench, however, sent no `X-Org-Id`, treated
 * the refusal as an unremarkable query failure, and left "Checking your session…" on
 * screen forever. Every invited user hit it. Nothing in the app said so.
 *
 * Two behaviours are pinned here, and they are the two halves of that bug:
 *
 *   1. **The refusal is a question, so the app asks it** — and once answered, every
 *      subsequent request names the organization.
 *   2. **No failure ends in a spinner.** Whatever `/v1/auth/me` returns, the user gets
 *      either the app, a choice, or a message they can act on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  const { apiStub } = await import('./stub');
  return { ...actual, api: apiStub };
});

const { apiStub, renderAt, signIn, signInWithoutOrg, signOut } = await import('./harness');
const { ApiError, request, setActiveOrg, setAuthToken } = await import('../src/lib/api');
const { organizationsFromError } = await import('../src/lib/org');
const { useSession } = await import('../src/lib/session');
const fixtures = await import('./fixtures');

const AMBIGUOUS = new ApiError(
  400,
  'NO_ORG_CONTEXT',
  'Your account belongs to several organizations, so the target is ambiguous.',
  'Send an X-Org-Id header naming the organization to act in.',
  {
    organizations: [
      { id: 'o1', name: 'Acme Quantum', slug: 'acme', role: 'viewer' },
      { id: 'o2', name: 'Hopper Review', slug: 'hopper', role: 'owner' },
    ],
  },
);

beforeEach(() => {
  signOut();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('the organization a request acts in', () => {
  it('travels as X-Org-Id once one is chosen', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setAuthToken('test-token');
    setActiveOrg('o2');

    await request('/v1/projects');

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['x-org-id']).toBe('o2');

    setActiveOrg(null);
    await request('/v1/projects');
    // Absent, not empty: an empty header is a value, and the API would read it as a
    // request to act in an organization whose id is the empty string.
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)['x-org-id']).toBeUndefined();

    setAuthToken(null);
    vi.unstubAllGlobals();
  });

  it('survives a reload: the choice is remembered', () => {
    useSession.getState().chooseOrg('o2');
    expect(localStorage.getItem('qsynth.org')).toBe('o2');
    useSession.getState().signOut();
    expect(localStorage.getItem('qsynth.org')).toBeNull();
  });

  it('reads the candidates out of the refusal, in either shape', () => {
    expect(organizationsFromError(AMBIGUOUS)).toEqual([
      { id: 'o1', name: 'Acme Quantum', role: 'viewer' },
      { id: 'o2', name: 'Hopper Review', role: 'owner' },
    ]);

    // An older API sent bare ids. Something nameable is better than an empty screen.
    const legacy = new ApiError(400, 'NO_ORG_CONTEXT', 'm', 'h', { organizations: ['898e589f-72e0-4b64-a008'] });
    expect(organizationsFromError(legacy)).toEqual([{ id: '898e589f-72e0-4b64-a008', name: 'Organization 898e589f' }]);

    expect(organizationsFromError(new ApiError(400, 'NO_ORG_CONTEXT', 'm', 'h', {}))).toEqual([]);
    expect(organizationsFromError(new Error('not an api error'))).toEqual([]);
  });
});

describe('signing in as someone who belongs to two organizations', () => {
  it('asks which one instead of spinning, then works in the one chosen', async () => {
    signInWithoutOrg();
    apiStub.me.mockRejectedValueOnce(AMBIGUOUS);
    renderAt('/');

    await screen.findByRole('heading', { name: 'Choose an organization' });
    // The bug this replaces: the spinner was the whole screen, indefinitely.
    expect(screen.queryByText('Checking your session…')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Hopper Review/ }));

    await waitFor(() => expect(useSession.getState().activeOrgId).toBe('o2'));
    // And the app proceeds: `me` is asked again, now with the org named.
    await screen.findByRole('heading', { name: 'Projects' });
    expect(apiStub.me.mock.calls.length).toBeGreaterThan(1);
  });

  it('offers the choice again rather than guessing when nothing is nameable', async () => {
    signInWithoutOrg();
    apiStub.me.mockRejectedValue(new ApiError(400, 'NO_ORG_CONTEXT', 'Ambiguous.', 'Name one.', {}));
    renderAt('/');

    await screen.findByRole('heading', { name: 'Choose an organization' });
    expect(screen.getByText(/did not say which organizations/)).toBeTruthy();
    apiStub.me.mockResolvedValue(fixtures.principal);
  });
});

describe('a session check that fails for any other reason', () => {
  it('shows the refusal with its code and hint, not a spinner', async () => {
    signIn();
    useSession.setState({ loading: true });
    apiStub.me.mockRejectedValueOnce(
      new ApiError(503, 'INTERNAL', 'The service is unavailable.', 'Try again in a moment.'),
    );
    renderAt('/');

    await screen.findByRole('heading', { name: 'Your session could not be checked' });
    expect(screen.getByText('The service is unavailable.')).toBeTruthy();
    expect(screen.getByText('Try again in a moment.')).toBeTruthy();
    expect(screen.getByText(/INTERNAL · HTTP 503/)).toBeTruthy();
    expect(screen.queryByText('Checking your session…')).toBeNull();

    // And it can be retried without reloading the page.
    apiStub.me.mockResolvedValue(fixtures.principal);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Projects' });
  });

  it('drops a remembered organization the caller is no longer a member of', async () => {
    signIn([{ id: 'o9', name: 'Former Employer', role: 'viewer' }]);
    useSession.setState({ loading: true });
    apiStub.me.mockRejectedValueOnce(
      new ApiError(403, 'NOT_A_MEMBER', 'You are not a member of the requested organization.', 'Remove the header.'),
    );
    renderAt('/');

    // Self-healing: the stale local guess is cleared and the question is put back to the
    // server, which here has one obvious answer. What must not survive is 'o9'.
    await screen.findByRole('heading', { name: 'Projects' });
    expect(useSession.getState().activeOrgId).toBe('o1');
    expect(localStorage.getItem('qsynth.org')).toBe('o1');
  });
});

describe('the organization switcher', () => {
  it('appears only when there is somewhere to switch to', async () => {
    signIn();
    const single = renderAt('/');
    await screen.findByRole('heading', { name: 'Projects' });
    expect(screen.queryByLabelText('Organization')).toBeNull();
    single.unmount();

    signIn([
      { id: 'o1', name: 'Acme Quantum', role: 'owner' },
      { id: 'o2', name: 'Hopper Review', role: 'viewer' },
    ]);
    renderAt('/');
    await screen.findByRole('heading', { name: 'Projects' });

    const select = screen.getByLabelText('Organization') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'o2' } });
    await waitFor(() => expect(localStorage.getItem('qsynth.org')).toBe('o2'));
    // Who the caller is and what they may do are asked again for the new organization
    // rather than carried across from the old one.
    expect(apiStub.me.mock.calls.length).toBeGreaterThan(1);
  });

  it('drops the previous organization‘s permissions the moment it switches', () => {
    signIn();
    useSession.setState({ permissions: ['project:write'] });

    useSession.getState().chooseOrg('o2');

    // Not cosmetic: `can()` decides which buttons exist, and the permissions in the store
    // were granted by the organization being left. Keeping them for even one render shows
    // a viewer the controls of an owner.
    expect(useSession.getState().permissions).toEqual([]);
    expect(useSession.getState().loading).toBe(true);
  });
});
