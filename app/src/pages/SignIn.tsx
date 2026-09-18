/**
 * Sign in, or create the first organization.
 *
 * One form with a mode switch rather than two routes: the two differ by two fields, and a
 * separate route would mean a second copy of the same error handling.
 *
 * The inputs are a real `<form>` with real `<label for>` pairs and `autoComplete` hints —
 * password managers and screen readers both depend on that, and neither is served by a
 * `<div>` with a placeholder.
 */
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/ErrorNotice';

export default function SignInPage() {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const signIn = useSession((s) => s.signIn);
  const navigate = useNavigate();
  const location = useLocation();
  const destination = (location.state as { from?: string } | null)?.from ?? '/';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session =
        mode === 'signin'
          ? await api.login({ email, password })
          : await api.register({ email, password, name, organizationName });
      signIn(session);
      navigate(destination, { replace: true });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">QSYNTH</h1>
        <p className="mt-1 text-sm text-ink-dim">
          Classical specifications in, verified quantum circuits out. Nothing is exported until the checks pass.
        </p>
      </div>

      <form className="qs-panel flex flex-col gap-4 p-4" onSubmit={submit}>
        <h2 className="qs-label m-0">{mode === 'signin' ? 'Sign in' : 'Create an organization'}</h2>

        {mode === 'register' ? (
          <>
            <div className="flex flex-col gap-1">
              <label className="qs-label" htmlFor="name">
                Your name
              </label>
              <input
                id="name"
                className="qs-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="qs-label" htmlFor="organizationName">
                Organization
              </label>
              <input
                id="organizationName"
                className="qs-input"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                autoComplete="organization"
                required
              />
            </div>
          </>
        ) : null}

        <div className="flex flex-col gap-1">
          <label className="qs-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="qs-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="qs-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="qs-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            required
          />
          {mode === 'register' ? (
            <p className="text-xs text-ink-faint">At least 12 characters.</p>
          ) : null}
        </div>

        {error ? <ErrorNotice error={error} /> : null}

        <button type="submit" className="qs-btn qs-btn-primary" disabled={busy}>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create organization'}
        </button>

        <p className="text-sm text-ink-dim">
          {mode === 'signin' ? 'No organization yet?' : 'Already have one?'}{' '}
          <button
            type="button"
            className="qs-link"
            onClick={() => {
              setMode(mode === 'signin' ? 'register' : 'signin');
              setError(null);
            }}
          >
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </form>
    </main>
  );
}
