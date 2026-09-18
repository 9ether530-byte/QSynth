/**
 * "Which organization?" — the screen a multi-org user sees instead of a spinner.
 *
 * The API refuses to pick an organization for a user who belongs to more than one; it
 * answers `NO_ORG_CONTEXT` and names the candidates. That refusal is not an error in the
 * usual sense — nothing is broken and there is nothing to retry — it is a question, and
 * the only correct interface for a question is to ask it.
 *
 * It is a list of buttons rather than a `<select>` and a submit: there is exactly one
 * decision, each option is a single activation, and a native button is reachable, labelled
 * and operable by every input device without a line of extra code.
 */
import { useChooseOrg, type OrgOption } from '../lib/org';

export function OrgChooser({ options, title }: { options: readonly OrgOption[]; title?: string }) {
  const chooseOrg = useChooseOrg();

  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight">{title ?? 'Choose an organization'}</h1>
        <p className="mt-1 text-sm text-ink-dim">
          Your account belongs to more than one. Everything in the workbench — projects, circuits, keys, and the
          audit log — belongs to exactly one organization, so pick the one to work in. You can switch at any time
          from the header.
        </p>
      </div>

      {options.length === 0 ? (
        <p className="border border-rule px-3 py-2 text-sm text-ink-dim">
          The API did not say which organizations your account belongs to. Sign out and in again, or ask an owner
          to confirm your membership.
        </p>
      ) : (
        <ul className="m-0 list-none border border-rule p-0">
          {options.map((option) => (
            <li key={option.id} className="border-b border-rule last:border-b-0">
              <button
                type="button"
                className="flex w-full items-baseline justify-between gap-3 px-3 py-3 text-left hover:bg-panel"
                onClick={() => chooseOrg(option.id)}
              >
                <span className="text-sm text-ink">{option.name}</span>
                {option.role ? <span className="font-mono text-xs text-ink-dim">{option.role}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
