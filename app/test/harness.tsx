/**
 * Rendering helpers. The stub itself lives in `stub.ts` — see the note there for why the
 * two cannot share a module.
 *
 * Tests replace only the `api` object. `ApiError`, `request`, and the token plumbing stay
 * real, so a component that branches on an error code is exercised against the same class
 * the browser would hand it.
 */
import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { useSession, type SessionOrg } from '../src/lib/session';
import * as fixtures from './fixtures';

export { apiStub } from './stub';

/** Put the store in the state a signed-in reload would reach. */
export function signIn(organizations: readonly SessionOrg[] = [{ id: 'o1', name: 'Acme Quantum', role: 'owner' }]): void {
  useSession.setState({
    token: 'test-token',
    user: { id: 'u1', email: 'eng@example.com', name: 'Engineer' },
    organization: organizations[0] ?? null,
    activeOrgId: organizations[0]?.id ?? null,
    organizations,
    permissions: fixtures.principal.permissions ?? [],
    loading: false,
  });
}

/** Signed in, but with no organization chosen yet — a reload before the first `me`. */
export function signInWithoutOrg(): void {
  useSession.setState({
    token: 'test-token',
    user: { id: 'u1', email: 'eng@example.com', name: 'Engineer' },
    organization: null,
    activeOrgId: null,
    organizations: [],
    permissions: [],
    loading: true,
  });
}

export function signOut(): void {
  useSession.setState({
    token: null,
    user: null,
    organization: null,
    activeOrgId: null,
    organizations: [],
    permissions: [],
    loading: false,
  });
}

export function renderAt(route: string, element?: ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{element ?? <App />}</MemoryRouter>
    </QueryClientProvider>,
  );
}
