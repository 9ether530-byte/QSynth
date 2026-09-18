/**
 * The panel primitive and the small pieces that live inside one.
 *
 * Panels are `<section>`s with a real heading, not styled `<div>`s: the workbench is four
 * panels on one screen, and a screen-reader user navigating by heading is the only one who
 * can move between them as quickly as a sighted user moves their eyes.
 */
import type { ReactNode } from 'react';

export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = '',
  headingLevel = 2,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <section className={`qs-panel flex min-h-0 flex-col ${className}`} aria-label={title}>
      <header className="flex items-center justify-between gap-4 border-b border-rule px-3 py-2">
        <Heading className="qs-label m-0">{title}</Heading>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={`min-h-0 flex-1 overflow-auto ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** A label/value row. `<dl>` semantics, so the pairing is not purely visual. */
export function Field({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule/60 px-3 py-1.5 last:border-b-0">
      <dt className="qs-label m-0 normal-case tracking-normal">{label}</dt>
      <dd className={`m-0 text-right text-sm ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

export function FieldList({ children }: { children: ReactNode }) {
  return <dl className="m-0">{children}</dl>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-sm text-ink-faint">{children}</p>;
}
