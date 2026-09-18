/**
 * How a failure is shown.
 *
 * The server sends a stable `code`, a `message`, and a `hint` — the hint is the sentence
 * that tells the user what to *do*. Dropping it and printing only the message is the most
 * common way an interface turns an actionable error into a dead end, so the hint is not
 * optional here.
 *
 * `role="alert"` so a failure that appears after a button press is announced rather than
 * silently painted somewhere the user is not looking.
 */
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

export function ErrorNotice({ error, children }: { error: unknown; children?: ReactNode }) {
  const api = error instanceof ApiError ? error : null;
  const message = api ? api.message : error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="border border-failed/60 bg-failed/5 px-3 py-2 text-sm">
      <p className="flex items-baseline gap-2 font-medium text-failed">
        <span aria-hidden="true">✕</span>
        <span>{message}</span>
      </p>
      {api ? (
        <>
          <p className="mt-1 text-ink-dim">{api.hint}</p>
          <p className="mt-1 font-mono text-xs text-ink-faint">
            {api.code}
            {api.status ? ` · HTTP ${api.status}` : ''}
            {api.span ? ` · line ${api.span.line}, column ${api.span.column}` : ''}
          </p>
        </>
      ) : null}
      {children}
    </div>
  );
}
