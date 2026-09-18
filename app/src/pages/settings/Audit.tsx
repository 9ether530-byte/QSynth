/**
 * The audit log.
 *
 * Append-only at the database level, so this page is a reader and nothing else — no edit,
 * no delete, not even a hidden one. Paging is by cursor (`nextBefore`) because an offset
 * over an append-only table shifts under the reader as new entries arrive.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AuditEntry } from '../../lib/types';
import { Panel, Empty } from '../../components/Panel';
import { ErrorNotice } from '../../components/ErrorNotice';

function actorOf(entry: AuditEntry): string {
  if (entry.actor.kind === 'user') return entry.actor.email;
  if (entry.actor.kind === 'api_key') return `api key ${entry.actor.id.slice(0, 8)}`;
  return 'system';
}

export default function AuditPage() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [action, setAction] = useState('');

  const page = useQuery({
    queryKey: ['audit', cursor, action],
    queryFn: () => api.auditLogs({ limit: 50, ...(cursor ? { before: cursor } : {}), ...(action ? { action } : {}) }),
  });

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <h1 className="font-display text-xl font-semibold tracking-tight">Audit log</h1>
      <p className="mt-1 text-sm text-ink-dim">
        Every authentication, compile, export, and membership change. Entries cannot be edited or deleted.
      </p>

      <div className="mt-6">
        <Panel
          title="Entries"
          actions={
            <>
              <label className="qs-label" htmlFor="audit-action">
                Action
              </label>
              <input
                id="audit-action"
                className="qs-input py-0.5 text-xs"
                placeholder="compile.succeeded"
                value={action}
                onChange={(event) => {
                  setAction(event.target.value);
                  setCursor(undefined);
                }}
              />
            </>
          }
        >
          {page.isPending ? (
            <Empty>Loading…</Empty>
          ) : page.error ? (
            <div className="p-3">
              <ErrorNotice error={page.error} />
            </div>
          ) : page.data && page.data.entries.length > 0 ? (
            <>
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Audit entries, most recent first</caption>
                <thead>
                  <tr className="border-b border-rule text-left">
                    <th scope="col" className="qs-label px-3 py-2">
                      When
                    </th>
                    <th scope="col" className="qs-label px-3 py-2">
                      Action
                    </th>
                    <th scope="col" className="qs-label px-3 py-2">
                      Actor
                    </th>
                    <th scope="col" className="qs-label px-3 py-2">
                      Resource
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.data.entries.map((entry) => (
                    <tr key={entry.id} className="border-b border-rule/60 align-top last:border-b-0">
                      <td className="px-3 py-1.5 font-mono text-xs text-ink-faint">
                        {entry.at.replace('T', ' ').slice(0, 19)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs">{entry.action}</td>
                      <td className="px-3 py-1.5 text-xs text-ink-dim">{actorOf(entry)}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-ink-faint">
                        {entry.resource.type}
                        {entry.resource.id ? ` ${entry.resource.id.slice(0, 8)}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center gap-2 border-t border-rule px-3 py-2">
                <button type="button" className="qs-btn" onClick={() => setCursor(undefined)} disabled={!cursor}>
                  Newest
                </button>
                <button
                  type="button"
                  className="qs-btn"
                  onClick={() => setCursor(page.data.nextBefore ?? undefined)}
                  disabled={!page.data.nextBefore}
                >
                  Older
                </button>
              </div>
            </>
          ) : (
            <Empty>No entries match.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}
