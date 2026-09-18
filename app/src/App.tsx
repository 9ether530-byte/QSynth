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
import { useSession } from './lib/session';
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

function RequireSession({ children }: { children: React.ReactNode }) {
  const token = useSession((s) => s.token);
  const loading = useSession((s) => s.loading);
  const adopt = useSession((s) => s.adopt);
  const signOut = useSession((s) => s.signOut);
  const location = useLocation();

  const principal = useQuery({
    queryKey: ['me', token],
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

  if (!token) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
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
