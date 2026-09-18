/**
 * Two compiles, side by side (FR-9.4).
 *
 * A diff that showed only the resource numbers would answer "did it get cheaper" but not
 * "what changed", and a diff that showed only gates would answer the reverse. Both are
 * here, and the gate diff is a real subsequence diff so an inserted subexpression reads as
 * an insertion rather than as every following gate having moved.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCircuit } from '../lib/artifacts';
import { diffGates, type Op } from '../lib/diff';
import { gateLabel } from '../components/CircuitDiagram';
import { Panel, Empty, Field, FieldList } from '../components/Panel';
import { ErrorNotice } from '../components/ErrorNotice';
import { StatusText } from '../components/Status';
import type { CompileDetail, ReversibleCircuit } from '../lib/types';

function signatures(circuit: ReversibleCircuit | undefined): string[] {
  if (!circuit) return [];
  const names: string[] = [];
  for (const wire of circuit.wires) names[wire.index] = wire.name;
  // The label carries the gate index, which must not take part in the comparison — two
  // identical gates at different positions are the same gate.
  return circuit.gates.map((gate, index) => gateLabel(gate, index, names).replace(/^Gate \d+: /, ''));
}

function Delta({ label, a, b }: { label: string; a: number | null | undefined; b: number | null | undefined }) {
  const left = a ?? null;
  const right = b ?? null;
  const delta = left !== null && right !== null ? right - left : null;
  const tone = delta === null || delta === 0 ? 'neutral' : delta < 0 ? 'verified' : 'warning';
  return (
    <Field
      label={label}
      value={
        <span className="flex items-baseline justify-end gap-2">
          <span className="text-ink-dim">
            {left ?? '—'} → {right ?? '—'}
          </span>
          <StatusText tone={tone} label={delta === null ? 'n/a' : delta === 0 ? 'no change' : delta > 0 ? `+${delta}` : String(delta)} />
        </span>
      }
    />
  );
}

const OP_STYLE: Record<Op, string> = {
  same: 'text-ink-faint',
  added: 'text-verified',
  removed: 'text-failed line-through decoration-failed/50',
};

const OP_MARK: Record<Op, string> = { same: ' ', added: '+', removed: '−' };

export default function DiffPage() {
  const { projectId = '', a = '', b = '' } = useParams();
  const [onlyChanges, setOnlyChanges] = useState(true);

  const jobA = useQuery({ queryKey: ['job', a], queryFn: () => api.job(a) });
  const jobB = useQuery({ queryKey: ['job', b], queryFn: () => api.job(b) });

  const circuitA = useCircuit(jobA.data?.artifacts ?? []);
  const circuitB = useCircuit(jobB.data?.artifacts ?? []);

  const result = useMemo(
    () => diffGates(signatures(circuitA.data), signatures(circuitB.data)),
    [circuitA.data, circuitB.data],
  );

  const rows = onlyChanges ? result.rows.filter((row) => row.op !== 'same') : result.rows;

  const detailA: CompileDetail | undefined = jobA.data;
  const detailB: CompileDetail | undefined = jobB.data;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <div>
        <Link to={`/p/${projectId}`} className="qs-link text-xs">
          ← Workbench
        </Link>
        <h1 className="font-display text-xl font-semibold tracking-tight">Compare compiles</h1>
        <p className="mt-1 font-mono text-xs text-ink-faint">
          {a.slice(0, 8)} → {b.slice(0, 8)}
        </p>
      </div>

      {jobA.error ? <ErrorNotice error={jobA.error} /> : null}
      {jobB.error ? <ErrorNotice error={jobB.error} /> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-4">
          <Panel title="Resources">
            {detailA && detailB ? (
              <FieldList>
                <Delta label="Qubits" a={detailA.resources?.measured.qubits} b={detailB.resources?.measured.qubits} />
                <Delta
                  label="Ancillas"
                  a={detailA.resources?.measured.ancillaQubits}
                  b={detailB.resources?.measured.ancillaQubits}
                />
                <Delta label="Gates" a={detailA.resources?.measured.gateCount} b={detailB.resources?.measured.gateCount} />
                <Delta label="Depth" a={detailA.resources?.measured.depth} b={detailB.resources?.measured.depth} />
                <Delta label="T count" a={detailA.resources?.cliffordT.tCount} b={detailB.resources?.cliffordT.tCount} />
                <Delta label="T depth" a={detailA.resources?.cliffordT.tDepth} b={detailB.resources?.cliffordT.tDepth} />
                <Delta
                  label="Two-qubit gates"
                  a={detailA.resources?.cliffordT.twoQubitGates}
                  b={detailB.resources?.cliffordT.twoQubitGates}
                />
              </FieldList>
            ) : (
              <Empty>Loading…</Empty>
            )}
          </Panel>

          <Panel title="Specifications">
            <div className="grid grid-cols-2 gap-px bg-rule">
              {[detailA, detailB].map((detail, index) => (
                <div key={index} className="bg-panel p-3">
                  <p className="qs-label">{index === 0 ? 'Before' : 'After'}</p>
                  <p className="mt-1 font-mono text-xs text-ink-faint">{detail?.spec?.kind ?? '—'}</p>
                  <pre className="mt-2 max-h-56 overflow-auto font-mono text-xs text-ink-dim">
                    {detail?.spec?.source ?? ''}
                  </pre>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <Panel
          title="Gates"
          actions={
            <label className="flex items-center gap-2 text-xs text-ink-dim">
              <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
              Only changes
            </label>
          }
        >
          {circuitA.error || circuitB.error ? (
            <div className="p-3">
              <ErrorNotice error={circuitA.error ?? circuitB.error} />
            </div>
          ) : result.truncated ? (
            <p className="p-3 text-sm text-ink-dim">
              These circuits are larger than the {1200}-gate limit for a gate-level diff. The resource deltas above are
              still exact; the gate list is not compared.
            </p>
          ) : rows.length === 0 ? (
            <Empty>{result.rows.length === 0 ? 'Loading…' : 'The gate lists are identical.'}</Empty>
          ) : (
            <>
              <p className="border-b border-rule px-3 py-2 text-xs text-ink-dim">
                <span className="text-verified">+{result.added} added</span> ·{' '}
                <span className="text-failed">−{result.removed} removed</span> · {result.rows.length - result.added - result.removed}{' '}
                unchanged
              </p>
              <ol className="m-0 max-h-[32rem] list-none overflow-auto p-0 font-mono text-xs">
                {rows.map((row, index) => (
                  <li key={index} className={`flex gap-2 px-3 py-0.5 ${OP_STYLE[row.op]}`}>
                    <span aria-hidden="true" className="w-3 shrink-0">
                      {OP_MARK[row.op]}
                    </span>
                    <span className="sr-only">{row.op === 'same' ? 'unchanged' : row.op}</span>
                    <span className="w-10 shrink-0 text-right text-ink-faint">
                      {row.indexB ?? row.indexA ?? ''}
                    </span>
                    <span>{row.text}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
