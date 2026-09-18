/**
 * API keys.
 *
 * The secret is shown once, on creation, because only its SHA-256 is stored. The interface
 * says so before the key is created rather than after, and the panel holding the secret
 * does not disappear on a re-render — losing it means issuing a new key, which is a real
 * cost to put behind an accidental click.
 *
 * Scopes must be a subset of the creator's own permissions; the API enforces that, and the
 * checkbox list only offers what the current session actually holds, so the common case
 * never produces a rejection.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { usePermission, useSession } from '../../lib/session';
import type { ApiKeyCreated } from '../../lib/types';
import { Panel, Empty } from '../../components/Panel';
import { ErrorNotice } from '../../components/ErrorNotice';
import { StatusText } from '../../components/Status';

const ALL_SCOPES = [
  'project:read',
  'project:write',
  'project:delete',
  'compile:run',
  'compile:read',
  'artifact:read',
  'member:read',
  'member:write',
  'apikey:read',
  'apikey:write',
  'audit:read',
  'org:write',
] as const;

export default function KeysPage() {
  const queryClient = useQueryClient();
  const canWrite = usePermission('apikey:write');
  const permissions = useSession((s) => s.permissions);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['compile:run', 'compile:read', 'artifact:read']);
  const [issued, setIssued] = useState<ApiKeyCreated | null>(null);

  const keys = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] });

  const create = useMutation({
    mutationFn: () => api.createApiKey({ name, scopes }),
    onSuccess: (response) => {
      setIssued(response);
      setName('');
      invalidate();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeApiKey(id), onSuccess: invalidate });

  const offered = ALL_SCOPES.filter((scope) => permissions.includes(scope));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <h1 className="font-display text-xl font-semibold tracking-tight">API keys</h1>
      <p className="mt-1 text-sm text-ink-dim">
        A key's scopes are frozen at creation. Granting yourself more permissions later does not widen a key that
        already exists.
      </p>

      {issued ? (
        <div className="mt-6 border border-verified bg-verified/5 p-3" role="status">
          <p className="flex items-baseline gap-2 font-medium text-verified">
            <span aria-hidden="true">✓</span> Key created — copy it now
          </p>
          <p className="mt-1 text-sm text-ink-dim">{issued.notice}</p>
          <code className="mt-2 block overflow-auto border border-rule bg-ground p-2 font-mono text-xs">
            {issued.secret}
          </code>
          <button type="button" className="qs-btn mt-2" onClick={() => setIssued(null)}>
            I have copied it
          </button>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-6">
        <Panel title="Keys">
          {keys.isPending ? (
            <Empty>Loading…</Empty>
          ) : keys.error ? (
            <div className="p-3">
              <ErrorNotice error={keys.error} />
            </div>
          ) : keys.data && keys.data.apiKeys.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {keys.data.apiKeys.map((key) => (
                <li key={key.id} className="border-b border-rule/60 px-3 py-2 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span>
                      {key.name} <span className="font-mono text-xs text-ink-faint">{key.prefix}…</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <StatusText tone={key.revoked ? 'failed' : 'verified'} label={key.revoked ? 'revoked' : 'active'} />
                      {canWrite && !key.revoked ? (
                        <button type="button" className="qs-btn" onClick={() => revoke.mutate(key.id)}>
                          Revoke
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-ink-faint">
                    {key.scopes.join(' ')} · created {key.createdAt.slice(0, 10)}
                    {key.lastUsedAt ? ` · last used ${key.lastUsedAt.slice(0, 10)}` : ' · never used'}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No keys issued.</Empty>
          )}
          {revoke.error ? (
            <div className="p-3">
              <ErrorNotice error={revoke.error} />
            </div>
          ) : null}
        </Panel>

        {canWrite ? (
          <Panel title="Issue a key">
            <form className="flex flex-col gap-3 p-3" onSubmit={submit}>
              <div className="flex flex-col gap-1">
                <label className="qs-label" htmlFor="key-name">
                  Name
                </label>
                <input
                  id="key-name"
                  className="qs-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ci-pipeline"
                  required
                />
              </div>
              <fieldset className="border border-rule p-3">
                <legend className="qs-label px-1">Scopes</legend>
                <div className="grid grid-cols-2 gap-1">
                  {offered.map((scope) => (
                    <label key={scope} className="flex items-center gap-2 font-mono text-xs">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={(event) =>
                          setScopes((current) =>
                            event.target.checked ? [...current, scope] : current.filter((s) => s !== scope),
                          )
                        }
                      />
                      {scope}
                    </label>
                  ))}
                </div>
              </fieldset>
              {create.error ? <ErrorNotice error={create.error} /> : null}
              <button type="submit" className="qs-btn qs-btn-primary" disabled={create.isPending || scopes.length === 0}>
                {create.isPending ? 'Creating…' : 'Create key'}
              </button>
              <p className="text-xs text-ink-faint">The secret is displayed once and is not recoverable afterwards.</p>
            </form>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
