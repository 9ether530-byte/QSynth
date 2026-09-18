/**
 * The trace console (FR-6).
 *
 * These entries are recorded *during* lowering — they are the compiler's own account of
 * why each gate and each ancilla exists, not a summary reconstructed afterwards. So the
 * console does no interpretation: it filters, and it links.
 *
 * An entry that names a gate highlights that gate in the diagram; an entry that carries a
 * source span highlights that line in the editor. Same in reverse, which is what makes
 * "why is this Toffoli here" a one-hover question.
 */
import { useMemo, useState } from 'react';
import type { TraceEntry } from '../lib/types';
import { Empty } from './Panel';

export function TraceConsole({
  entries,
  selectedGate,
  onSelect,
}: {
  entries: readonly TraceEntry[];
  selectedGate: number | null;
  onSelect: (selection: { gateIndex: number | null; line: number | null }) => void;
}) {
  const [phase, setPhase] = useState<string>('all');

  const phases = useMemo(() => {
    const seen: string[] = [];
    for (const entry of entries) if (!seen.includes(entry.phase)) seen.push(entry.phase);
    return seen;
  }, [entries]);

  const visible = useMemo(
    () => (phase === 'all' ? entries : entries.filter((entry) => entry.phase === phase)),
    [entries, phase],
  );

  if (entries.length === 0) return <Empty>Compile a specification to see its trace.</Empty>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-1.5">
        <label className="qs-label" htmlFor="trace-phase">
          Phase
        </label>
        <select
          id="trace-phase"
          className="qs-input py-0.5 text-xs"
          value={phase}
          onChange={(event) => setPhase(event.target.value)}
        >
          <option value="all">all ({entries.length})</option>
          {phases.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-ink-faint">{visible.length} entries</span>
      </div>

      <ol className="m-0 min-h-0 flex-1 list-none overflow-auto p-0 font-mono text-xs">
        {visible.map((entry) => {
          const linked = entry.gateIndex !== undefined && entry.gateIndex === selectedGate;
          return (
            <li
              key={entry.seq}
              className={`flex gap-3 border-b border-rule/40 px-3 py-1 last:border-b-0 ${
                linked ? 'bg-raised text-ink' : 'text-ink-dim'
              }`}
              onMouseEnter={() =>
                onSelect({ gateIndex: entry.gateIndex ?? null, line: entry.span?.line ?? null })
              }
              onMouseLeave={() => onSelect({ gateIndex: null, line: null })}
            >
              <span className="w-10 shrink-0 text-right text-ink-faint">{entry.seq}</span>
              <span className="w-28 shrink-0 text-ink-faint">{entry.phase}</span>
              <span className="w-32 shrink-0 text-ink-faint">{entry.kind}</span>
              <span className="min-w-0 flex-1">{entry.message}</span>
              <span className="w-24 shrink-0 text-right text-ink-faint">
                {entry.span ? `line ${entry.span.line}` : entry.gateIndex !== undefined ? `gate ${entry.gateIndex}` : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
