/**
 * The inspector: what the compiler measured, what the checks concluded, and where every
 * ancilla went.
 *
 * The verification section shows all six checks, including the ones that never ran. A
 * short-circuited run reports `checksReached`, and hiding the unreached checks would let a
 * failure on check 2 look like a circuit that passed the other five.
 *
 * The ancilla ledger shows uncompute points per ancilla. A null uncompute is garbage, and
 * is labelled as such rather than omitted.
 */
import type { CheckResult, Resources, ReversibleCircuit, VerificationView } from '../lib/types';
import { StatusBadge, StatusText, toneForCheck } from './Status';
import { Field, FieldList, Empty } from './Panel';

const CHECK_ORDER = [
  { id: 'type_shape', title: 'Type and shape' },
  { id: 'simulation_equivalence', title: 'Simulation equivalence' },
  { id: 'reversibility', title: 'Reversibility' },
  { id: 'garbage_free', title: 'Garbage-free' },
  { id: 'property', title: 'Properties' },
  { id: 'resource', title: 'Resource budget' },
] as const;

function number(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-US');
}

function CheckRow({ id, title, result }: { id: string; title: string; result: CheckResult | undefined }) {
  const status = result?.status ?? 'skipped';
  const tone = toneForCheck(status);
  return (
    <li className="border-b border-rule/60 px-3 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">{result?.title ?? title}</span>
        <StatusText tone={tone} label={status === 'skipped' ? 'not reached' : status} />
      </div>
      {result ? (
        <p className="mt-1 text-xs text-ink-dim">{result.summary}</p>
      ) : (
        <p className="mt-1 text-xs text-ink-faint">
          An earlier check failed, so this one did not run — it is unknown, not passed.
        </p>
      )}
      {result?.coverage ? (
        <p className="mt-1 font-mono text-xs text-ink-faint">
          {result.coverage.mode} · {number(result.coverage.checked)}/{number(result.coverage.space)} assignments
          {result.coverage.dontCare ? ` · ${number(result.coverage.dontCare)} don't-care` : ''}
        </p>
      ) : null}
      {result?.counterexample ? (
        <div className="mt-2 border border-failed/50 bg-failed/5 p-2 font-mono text-xs">
          <p className="m-0 text-failed">Counterexample</p>
          <p className="m-0 text-ink-dim">inputs {JSON.stringify(result.counterexample.inputs)}</p>
          <p className="m-0 text-ink-dim">expected {JSON.stringify(result.counterexample.expected)}</p>
          <p className="m-0 text-ink-dim">observed {JSON.stringify(result.counterexample.observed)}</p>
        </div>
      ) : null}
      <span className="sr-only">{`Check ${id}`}</span>
    </li>
  );
}

export function VerificationSection({ verification }: { verification: VerificationView }) {
  const byId = new Map(verification.checks.map((check) => [check.id, check]));
  return (
    <section aria-label="Verification">
      <div className="flex items-center justify-between gap-3 border-b border-rule px-3 py-2">
        <h3 className="qs-label m-0">Verification</h3>
        <StatusBadge
          tone={verification.passed ? 'verified' : 'failed'}
          label={verification.passed ? 'verified' : 'failed'}
          title={
            verification.passed
              ? 'Every check that applies to this circuit passed.'
              : `Stopped at ${verification.stoppedAt ?? 'a failing check'}.`
          }
        />
      </div>
      <ul className="m-0 list-none p-0">
        {CHECK_ORDER.map((check) => (
          <CheckRow key={check.id} id={check.id} title={check.title} result={byId.get(check.id)} />
        ))}
      </ul>
      {verification.optimization ? (
        <div className="border-t border-rule">
          <h3 className="qs-label px-3 py-2">Optimization</h3>
          <FieldList>
            <Field
              label="Gates"
              value={`${number(verification.optimization.gatesBefore)} → ${number(verification.optimization.gatesAfter)}`}
            />
            {verification.optimization.discarded > 0 ? (
              <Field
                label="Discarded passes"
                value={<span className="text-warning">{number(verification.optimization.discarded)}</span>}
              />
            ) : null}
          </FieldList>
          <ul className="m-0 list-none p-0">
            {verification.optimization.passes.map((pass) => (
              <li key={pass.pass} className="flex items-baseline justify-between gap-3 px-3 py-1 font-mono text-xs">
                <span className="text-ink-dim">{pass.pass}</span>
                <span
                  className={
                    pass.outcome === 'discarded' ? 'text-warning' : pass.outcome === 'applied' ? 'text-verified' : 'text-ink-faint'
                  }
                >
                  {pass.outcome} {pass.before} → {pass.after}
                </span>
              </li>
            ))}
          </ul>
          {verification.optimization.discarded > 0 ? (
            <p className="px-3 pb-3 text-xs text-ink-dim">
              A discarded pass changed the circuit's behaviour and was rejected by the equivalence guard. The
              unoptimized circuit was kept.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ResourceSection({ resources }: { resources: Resources }) {
  const m = resources.measured;
  const q = resources.cliffordT;
  return (
    <section aria-label="Resources" className="border-t border-rule">
      <h3 className="qs-label px-3 py-2">Resources</h3>
      <FieldList>
        <Field label="Qubits" value={number(m.qubits)} />
        <Field label="Ancilla qubits" value={number(m.ancillaQubits)} />
        <Field label="Reversible gates" value={number(m.gateCount)} />
        <Field label="Depth" value={number(m.depth)} />
        <Field label="Clifford+T gates" value={number(q.gateCount)} />
        <Field label="T count" value={number(q.tCount)} />
        <Field label="T depth" value={number(q.tDepth)} />
        <Field label="Two-qubit gates" value={number(q.twoQubitGates)} />
      </FieldList>
      <p className="px-3 pb-3 text-xs text-ink-faint">
        Clifford+T figures are {q.source === 'measured' ? 'measured from the decomposed circuit' : 'projected from the reversible circuit'}.
      </p>
    </section>
  );
}

export function AncillaSection({
  circuit,
  onSelectGate,
}: {
  circuit: ReversibleCircuit;
  onSelectGate: (index: number | null) => void;
}) {
  return (
    <section aria-label="Ancilla ledger" className="border-t border-rule">
      <h3 className="qs-label px-3 py-2">Ancilla ledger ({circuit.ancillas.length})</h3>
      {circuit.ancillas.length === 0 ? (
        <Empty>This circuit allocated no ancillas.</Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {circuit.ancillas.map((ancilla) => {
            const leaked = ancilla.uncomputedAtGate === null;
            return (
              <li
                key={ancilla.wire}
                className="border-b border-rule/60 px-3 py-2 last:border-b-0"
                onMouseEnter={() => onSelectGate(ancilla.allocatedAtGate)}
                onMouseLeave={() => onSelectGate(null)}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-xs text-ink">
                    {circuit.wires.find((w) => w.index === ancilla.wire)?.name ?? `q${ancilla.wire}`}
                  </span>
                  <StatusText tone={leaked ? 'failed' : 'verified'} label={leaked ? 'garbage' : 'uncomputed'} />
                </div>
                <p className="mt-1 text-xs text-ink-dim">{ancilla.purpose}</p>
                <p className="mt-0.5 font-mono text-xs text-ink-faint">
                  allocated at gate {ancilla.allocatedAtGate}
                  {leaked ? ' · never returned to |0⟩' : ` · uncomputed at gate ${ancilla.uncomputedAtGate}`}
                  {ancilla.span ? ` · line ${ancilla.span.line}` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
