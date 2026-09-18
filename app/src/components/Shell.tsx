/**
 * The frame every signed-in route renders inside.
 *
 * Two things here are for keyboard and screen-reader users specifically: a skip link as
 * the first focusable element (the workbench's nav is short, but the editor below it is
 * a focus trap of its own kind), and `<main id="main">` as the single main landmark so
 * that link has somewhere to land.
 */
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

function Tab({ to, children, end = false }: { to: string; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'border-b-2 px-3 py-2 text-sm transition-colors',
          isActive
            ? 'border-verified text-ink'
            : 'border-transparent text-ink-dim hover:border-rule-strong hover:text-ink',
        ].join(' ')
      }
    >
      {children}
    </NavLink>
  );
}

export function Shell() {
  const user = useSession((s) => s.user);
  const organization = useSession((s) => s.organization);
  const signOut = useSession((s) => s.signOut);
  const navigate = useNavigate();

  const leave = async () => {
    // Best effort: the server-side session row should go, but a failed logout must not
    // strand the user in a signed-in interface.
    try {
      await api.logout();
    } catch {
      /* ignored on purpose */
    }
    signOut();
    navigate('/signin', { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col bg-ground text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:border focus:border-verified focus:bg-panel focus:px-3 focus:py-2"
      >
        Skip to main content
      </a>

      <header className="flex items-center gap-6 border-b border-rule bg-panel px-4">
        <span className="font-display text-sm font-semibold tracking-[0.2em] text-ink">QSYNTH</span>
        <nav aria-label="Primary" className="flex items-center">
          <Tab to="/" end>
            Projects
          </Tab>
          <Tab to="/settings/members">Members</Tab>
          <Tab to="/settings/keys">API keys</Tab>
          <Tab to="/settings/audit">Audit</Tab>
        </nav>
        <div className="ml-auto flex items-center gap-4 text-xs text-ink-dim">
          {organization ? (
            <span>
              {organization.name} · <span className="font-mono">{organization.role}</span>
            </span>
          ) : null}
          {user ? <span className="font-mono">{user.email}</span> : null}
          <button type="button" className="qs-btn" onClick={leave}>
            Sign out
          </button>
        </div>
      </header>

      <main id="main" className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
