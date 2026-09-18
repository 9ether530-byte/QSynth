/**
 * The workbench: editor, diagram, inspector, trace — the four panels of FR-9.1.
 *
 * Two decisions worth stating, because both are about being honest with the user:
 *
 *   1. **A failed compile is not an empty screen.** `POST /v1/compile` answers a failed
 *      verification with a 422 rather than a result body, so the page follows the `jobId`
 *      in the error and loads the job. The failing check, its counterexample, and the
 *      checks that never ran are exactly what the user needs to see, and they are the part
 *      an interface is most tempted to swallow.
 *   2. **The diagram comes from the export gate.** The reversible IR and the trace are
 *      fetched through `GET /v1/artifacts/:id`, so a circuit that did not pass is refused
 *      here for the same reason and with the same message as at the API. The workbench
 *      does not get a private back door to unverified output.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { usePermission } from '../lib/session';
import { useCircuit, useQasm, useTrace } from '../lib/artifacts';
import type { ArtifactRef, SpecKind, VerificationView, Resources } from '../lib/types';
import { Panel, Empty, Field, FieldList } from '../components/Panel';
import { SpecEditor, type EditorMarker } from '../components/SpecEditor';
import { CircuitDiagram } from '../components/CircuitDiagram';
import { TraceConsole } from '../components/TraceConsole';
import { AncillaSection, ResourceSection, VerificationSection } from '../components/Inspector';
import { ErrorNotice } from '../components/ErrorNotice';
import { StatusBadge } from '../components/Status';

const STARTERS: Record<SpecKind, string> = {
  boolean: 'out = (a AND b) XOR c\n',
  truthtable: 'inputs: a b\noutputs: out\n0 0 | 0\n0 1 | 1\n1 0 | 1\n1 1 | 0\n',
  python: 'def add2(x: uint2, y: uint2) -> uint3:\n    return x + y\n',
};

const KIND_HINTS: Record<SpecKind, string> = {
  boolean: 'One assignment per line. Operators: AND, OR, XOR, NOT, parentheses.',
  truthtable: 'Declare inputs and outputs, then one row per assignment. Up to 12 inputs. Missing rows are reported as don’t-care, never filled in silently.',
  python: 'A restricted subset: typed uint parameters, arithmetic, comparisons, if/else, for over range(), assert. Anything outside it is refused by name and line.',
};

export default function WorkbenchPage() {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const canCompile = usePermission('compile:run');

  const [kind, setKind] = useState<SpecKind>('boolean');
  const [source, setSource] = useState(STARTERS.boolean);
  const [specName, setSpecName] = useState('spec');
  const [maxQubits, setMaxQubits] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ gateIndex: number | null; line: number | null }>({
    gateIndex: null,
    line: null,
  });

  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) });
  const jobs = useQuery({ queryKey: ['jobs', projectId], queryFn: () => api.jobs(projectId) });
  const job = useQuery({ queryKey: ['job', jobId], queryFn: () => api.job(jobId!), enabled: jobId !== null });

  const compile = useMutation({
    mutationFn: () =>
      api.compile({
        projectId,
        kind,
        source,
        name: specName,
        ...(maxQubits ? { budget: { maxQubits: Number(maxQubits) } } : {}),
      }),
    onSuccess: (response) => {
      setJobId(response.job.id);
      void queryClient.invalidateQueries({ queryKey: ['jobs', projectId] });
    },
    onError: (error) => {
      // A verification failure still produced a job, and that job is the whole explanation.
      if (error instanceof ApiError && typeof error.details['jobId'] === 'string') {
        setJobId(error.details['jobId']);
        void queryClient.invalidateQueries({ queryKey: ['jobs', projectId] });
      }
    },
  });

  const estimate = useMutation({ mutationFn: () => api.estimate({ kind, source, name: specName }) });

  const reverify = useMutation({
    mutationFn: () => api.reverify(jobId!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['job', jobId] }),
  });

  // The artifacts of whichever job is on screen.
  const artifacts: readonly ArtifactRef[] = job.data?.artifacts ?? [];
  const circuit = useCircuit(artifacts);
  const trace = useTrace(artifacts);
  const qasm = useQasm(artifacts);

  const verification: VerificationView | null = job.data?.verification ?? null;
  const resources: Resources | null = job.data?.resources ?? estimate.data?.resources ?? null;

  const markers: readonly EditorMarker[] = useMemo(() => {
    const error = (compile.error ?? estimate.error) as unknown;
    if (!(error instanceof ApiError)) return [];
    const span = error.details['span'];
    if (!span || typeof span !== 'object') return [];
    const { line, column, length } = span as { line?: number; column?: number; length?: number };
    if (typeof line !== 'number') return [];
    return [
      {
        span: { line, column: column ?? 1, ...(length ? { length } : {}) },
        message: `${error.code}: ${error.message}`,
        severity: 'error' as const,
      },
    ];
  }, [compile.error, estimate.error]);

  // Switching frontends with the previous starter untouched would silently produce a
  // parse error in the new notation, which reads as a compiler bug rather than a choice.
  const switchKind = (next: SpecKind) => {
    if (source.trim() === '' || Object.values(STARTERS).includes(source)) setSource(STARTERS[next]);
    setKind(next);
  };

  useEffect(() => {
    // A new job invalidates a selection that pointed into the previous circuit.
    setSelection({ gateIndex: null, line: null });
  }, [jobId]);

  const selectGate = (gateIndex: number | null) => {
    const entry = gateIndex === null ? undefined : trace.data?.find((e) => e.gateIndex === gateIndex);
    const gateSpan = gateIndex === null ? undefined : circuit.data?.gates[gateIndex]?.span;
    setSelection({ gateIndex, line: gateSpan?.line ?? entry?.span?.line ?? null });
  };

  const previous = jobs.data?.jobs.filter((j) => j.id !== jobId && j.status === 'succeeded')[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-rule bg-panel px-4 py-2">
        <div>
          <Link to="/" className="qs-link text-xs">
            ← Projects
          </Link>
          <h1 className="font-display text-base font-semibold tracking-tight">
            {project.data?.project.name ?? 'Project'}
          </h1>
        </div>

        <div className="flex flex-col gap-1">
          <label className="qs-label" htmlFor="spec-kind">
            Notation
          </label>
          <select
            id="spec-kind"
            className="qs-input py-1"
            value={kind}
            onChange={(event) => switchKind(event.target.value as SpecKind)}
          >
            <option value="boolean">Boolean expressions</option>
            <option value="truthtable">Truth table</option>
            <option value="python">Python subset</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="qs-label" htmlFor="spec-name">
            Specification name
          </label>
          <input id="spec-name" className="qs-input py-1" value={specName} onChange={(e) => setSpecName(e.target.value)} />
        </div>

        <div className="flex flex-col gap-1">
          <label className="qs-label" htmlFor="budget-qubits">
            Qubit budget
          </label>
          <input
            id="budget-qubits"
            className="qs-input w-28 py-1"
            inputMode="numeric"
            placeholder="none"
            value={maxQubits}
            onChange={(e) => setMaxQubits(e.target.value.replace(/\D/g, ''))}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="qs-btn" onClick={() => estimate.mutate()} disabled={estimate.isPending}>
            {estimate.isPending ? 'Estimating…' : 'Estimate'}
          </button>
          <button
            type="button"
            className="qs-btn qs-btn-primary"
            onClick={() => compile.mutate()}
            disabled={compile.isPending || !canCompile}
            title={canCompile ? undefined : 'Your role cannot start compiles.'}
          >
            {compile.isPending ? 'Compiling…' : 'Compile and verify'}
          </button>
          {verification ? (
            <StatusBadge
              tone={verification.passed ? 'verified' : 'failed'}
              label={verification.passed ? 'verified' : 'failed'}
            />
          ) : null}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-rule lg:grid-cols-[minmax(320px,1fr)_minmax(0,1.6fr)_minmax(320px,0.9fr)]">
        <Panel
          title="Specification"
          actions={<span className="text-xs text-ink-faint">{kind}</span>}
          className="border-0"
          bodyClassName="flex flex-col"
        >
          <div className="min-h-0 flex-1">
            <SpecEditor
              label={`${kind} specification`}
              value={source}
              onChange={setSource}
              markers={markers}
              highlight={selection.line}
              hint={STARTERS[kind]}
            />
          </div>
          <p className="border-t border-rule px-3 py-2 text-xs text-ink-dim">{KIND_HINTS[kind]}</p>
          {compile.error ? (
            <div className="border-t border-rule p-3">
              <ErrorNotice error={compile.error} />
            </div>
          ) : null}
          {estimate.error ? (
            <div className="border-t border-rule p-3">
              <ErrorNotice error={estimate.error} />
            </div>
          ) : null}
        </Panel>

        <Panel
          title="Circuit"
          className="border-0"
          actions={
            circuit.data ? (
              <span className="font-mono text-xs text-ink-faint">
                {circuit.data.wires.length} qubits · {circuit.data.gates.length} gates
              </span>
            ) : null
          }
        >
          {!jobId ? (
            <Empty>Compile a specification to draw its circuit.</Empty>
          ) : circuit.isPending ? (
            <Empty>Loading the reversible circuit…</Empty>
          ) : circuit.error ? (
            <div className="p-3">
              <ErrorNotice error={circuit.error}>
                {circuit.error instanceof ApiError && circuit.error.code === 'VERIFICATION_REQUIRED' ? (
                  <p className="mt-2 text-xs text-ink-dim">
                    The diagram is drawn from the stored artifact, and that artifact is behind the same export gate as
                    the API. Fix the failing check below and compile again.
                  </p>
                ) : null}
              </ErrorNotice>
            </div>
          ) : circuit.data ? (
            <CircuitDiagram circuit={circuit.data} selected={selection.gateIndex} onSelect={selectGate} />
          ) : (
            <Empty>No circuit.</Empty>
          )}
        </Panel>

        <Panel title="Inspector" className="border-0" bodyClassName="">
          {estimate.data && !jobId ? (
            <section aria-label="Estimate">
              <div className="border-b border-rule px-3 py-2">
                <StatusBadge tone="warning" label="estimate only" title="Nothing was verified and nothing was stored." />
              </div>
              <FieldList>
                <Field label="Projected gates" value={estimate.data.preflight.projectedGates.toLocaleString('en-US')} />
                <Field label="Inputs" value={String(estimate.data.preflight.inputs)} />
                <Field
                  label="Verification ops"
                  value={estimate.data.preflight.projectedVerificationOps.toLocaleString('en-US')}
                />
              </FieldList>
            </section>
          ) : null}

          {verification ? <VerificationSection verification={verification} /> : null}
          {resources ? <ResourceSection resources={resources} /> : null}
          {circuit.data ? <AncillaSection circuit={circuit.data} onSelectGate={selectGate} /> : null}

          {job.data ? (
            <section aria-label="Artifacts" className="border-t border-rule">
              <h3 className="qs-label px-3 py-2">Job</h3>
              <FieldList>
                <Field label="Job" value={<span className="text-xs">{job.data.job.id}</span>} />
                <Field label="Spec hash" value={<span className="text-xs">{job.data.job.specHash.slice(0, 12)}</span>} />
                <Field label="Compiler" value={<span className="text-xs">{job.data.job.compilerVersion}</span>} />
                {job.data.version ? <Field label="Version" value={`#${job.data.version.number}`} /> : null}
              </FieldList>
              <div className="flex flex-wrap gap-2 px-3 py-2">
                <button type="button" className="qs-btn" onClick={() => reverify.mutate()} disabled={reverify.isPending}>
                  {reverify.isPending ? 'Re-verifying…' : 'Re-verify from artifacts'}
                </button>
                {previous ? (
                  <Link className="qs-btn no-underline" to={`/p/${projectId}/diff/${previous.id}/${job.data.job.id}`}>
                    Compare with previous
                  </Link>
                ) : null}
              </div>
              {reverify.error ? (
                <div className="px-3 pb-3">
                  <ErrorNotice error={reverify.error} />
                </div>
              ) : null}
              {reverify.data ? (
                <p className={`px-3 pb-3 text-xs ${reverify.data.reproduced ? 'text-verified' : 'text-failed'}`}>
                  {reverify.data.reproduced
                    ? `Reproduced: re-running the stored specification under ${reverify.data.compilerVersion} reached the same verdict.`
                    : `Diverged from the stored report on ${reverify.data.divergence.map((d) => d.id).join(', ')}.`}
                </p>
              ) : null}
              {qasm.data ? (
                <details className="border-t border-rule">
                  <summary className="qs-label cursor-pointer px-3 py-2">OpenQASM 3.0</summary>
                  <pre className="m-0 max-h-64 overflow-auto px-3 pb-3 font-mono text-xs text-ink-dim">
                    {qasm.data.content}
                  </pre>
                </details>
              ) : null}
            </section>
          ) : null}

          {!jobId && !estimate.data ? <Empty>Nothing compiled yet.</Empty> : null}
        </Panel>
      </div>

      <div className="h-56 shrink-0 border-t border-rule bg-panel">
        <h2 className="qs-label border-b border-rule px-3 py-2">Trace</h2>
        <div className="h-[calc(100%-2.3rem)]">
          <TraceConsole
            entries={trace.data ?? []}
            selectedGate={selection.gateIndex}
            onSelect={(next) => setSelection(next)}
          />
        </div>
      </div>
    </div>
  );
}
