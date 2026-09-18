/**
 * Routes and the authentication gate.
 *
 * The gate is a convenience, not a control: it decides what to *render*, while every
 * permission is enforced by the API. On first load a stored token is checked against
 * `/v1/auth/me` — a token the server has revoked must not leave the app looking signed in.
 */
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './lib/api';
import { organizationsFromError } from './lib/org';
import { useSession } from './lib/session';
import { ErrorNotice } from './components/ErrorNotice';
import { OrgChooser } from './components/OrgChooser';
import { Shell } from './components/Shell';
import SignInPage from './pages/SignIn';
import ProjectsPage from './pages/Projects';
import WorkbenchPage from './pages/Workbench';
import DiffPage from './pages/Diff';
import MembersPage from './pages/settings/Members';
import KeysPage from './pages/settings/Keys';
import AuditPage from './pages/settings/Audit';

function Booting() {
  return (
    <p className="p-8 text-sm text-ink-dim" role="status">
      Checking your session…
    </p>
  );
}

/**
 * A session check that failed for a reason the app cannot resolve by itself.
 *
 * This exists because the alternative is worse than an error message: before it, any
 * failure other than 401 left `loading` true and "Checking your session…" on screen
 * forever. A spinner is a promise that something is still happening, and one that never
 * resolves is the least honest thing an interface can do — the user has no idea whether
 * to wait, reload, or sign in again. So the refusal is shown, with its code and hint, and
 * with the two actions that can actually change the outcome.
 */
function SessionFailure({ error, onRetry, onSignOut }: { error: unknown; onRetry: () => void; onSignOut: () => void }) {
  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="font-display text-xl font-semibold tracking-tight">Your session could not be checked</h1>
      <ErrorNotice error={error} />
      <div className="flex gap-2">
        <button type="button" className="qs-btn qs-btn-primary" onClick={onRetry}>
          Try again
        </button>
        <button type="button" className="qs-btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </main>
  );
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const token = useSession((s) => s.token);
  const activeOrgId = useSession((s) => s.activeOrgId);
  const loading = useSession((s) => s.loading);
  const adopt = useSession((s) => s.adopt);
  const chooseOrg = useSession((s) => s.chooseOrg);
  const signOut = useSession((s) => s.signOut);
  const location = useLocation();

  const principal = useQuery({
    // The org is part of the key: switching organizations must re-ask who the caller is
    // and what they may do there, not reuse the previous org's answer.
    queryKey: ['me', token, activeOrgId],
    queryFn: api.me,
    enabled: token !== null,
  });

  useEffect(() => {
    if (principal.data) adopt(principal.data);
  }, [principal.data, adopt]);

  useEffect(() => {
    // A stored token the server no longer honours is worse than no token: every panel
    // would render and every request behind it would fail.
    if (principal.error instanceof ApiError && principal.error.status === 401) signOut();
  }, [principal.error, signOut]);

  useEffect(() => {
    // The remembered organization is no longer one of theirs — removed from it, or the
    // browser is signed in as someone else now. Drop it and ask again with no header:
    // the server then either has one obvious answer or names the choices. Recovering is
    // better than reporting, when the thing to recover from is a stale local guess.
    if (principal.error instanceof ApiError && principal.error.code === 'NOT_A_MEMBER' && activeOrgId !== null) {
      chooseOrg(null);
    }
  }, [principal.error, activeOrgId, chooseOrg]);

  if (!token) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;

  const error = principal.error;
  if (error instanceof ApiError) {
    // Not a failure: a question. The user belongs to several organizations and the server
    // declines to guess which one this request meant.
    if (error.code === 'NO_ORG_CONTEXT') return <OrgChooser options={organizationsFromError(error)} />;
    // Handled by the effect above, which clears the stale org and refetches.
    if (error.code === 'NOT_A_MEMBER' && activeOrgId !== null) return <Booting />;
    if (error.status !== 401) {
      return <SessionFailure error={error} onRetry={() => void principal.refetch()} onSignOut={signOut} />;
    }
  } else if (error) {
    return <SessionFailure error={error} onRetry={() => void principal.refetch()} onSignOut={signOut} />;
  }

  if (loading && !principal.data) return <Booting />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route
        element={
          <RequireSession>
            <Shell />
          </RequireSession>
        }
      >
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/p/:projectId" element={<WorkbenchPage />} />
        <Route path="/p/:projectId/diff/:a/:b" element={<DiffPage />} />
        <Route path="/settings/members" element={<MembersPage />} />
        <Route path="/settings/keys" element={<KeysPage />} />
        <Route path="/settings/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
