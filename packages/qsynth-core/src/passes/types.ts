/**
 * The optimizer's vocabulary.
 *
 * A pass is a pure `(circuit) => circuit`. It is not trusted: the runner re-checks every
 * pass against the circuit it was given and discards any that changed the answer (FR-3).
 * That is the whole reason a pass may be written as plainly as the ones in this directory
 * are — a subtly wrong rewrite costs gates, never correctness.
 *
 * Passes are deliberately *not* allowed to report their own success. Everything in
 * `PassOutcome` is measured by the runner, from the circuits before and after, so a pass
 * that believes it fired but did not is reported as `no_change` rather than as applied.
 */
import type { ReversibleCircuit } from '../ir/reversible.js';
import type { Bit } from '../eval/classical.js';

export interface Pass {
  readonly id: string;
  readonly title: string;
  /** One sentence: what this rewrites, and why the result is smaller. */
  readonly rationale: string;
  run(circuit: ReversibleCircuit): ReversibleCircuit;
}

/** The three figures a pass can move, before and after it ran. */
export interface CircuitShape {
  readonly qubits: number;
  readonly gates: number;
  readonly depth: number;
}

/**
 * How much of the input space the guard covered. Identical in meaning to a check's
 * `Coverage`, and drawn from the same plan, so an accepted pass carries exactly the
 * evidence standard the circuit itself was accepted on — no more, and no less.
 */
export interface GuardCoverage {
  readonly mode: 'exhaustive' | 'sampled';
  readonly checked: number;
  readonly space: number;
  readonly seed?: number;
}

/**
 * What the guard saw when it caught a pass. Named by the user's own input and output
 * names rather than by wire index: the reader of this is a person deciding whether to
 * trust the compiler, and wire 7 means nothing to them.
 */
export interface PassDivergence {
  readonly assignment: number;
  readonly inputs: Record<string, Bit>;
  readonly expected: Record<string, Bit>;
  readonly observed: Record<string, Bit>;
  /** Plain-language statement of what the rewrite changed. */
  readonly detail: string;
}

export interface PassOutcome {
  readonly id: string;
  readonly title: string;
  /**
   * `applied` — the rewrite changed the circuit and the guard agreed it meant the same.
   * `no_change` — the pass found nothing to do.
   * `discarded` — the rewrite changed the answer, so it was thrown away and the circuit
   * it was given was kept. This is a compiler defect and is reported as one.
   */
  readonly status: 'applied' | 'no_change' | 'discarded';
  readonly summary: string;
  readonly before: CircuitShape;
  readonly after: CircuitShape;
  readonly durationMs: number;
  readonly divergence?: PassDivergence;
}

export interface OptimizationSummary {
  readonly guard: GuardCoverage;
  readonly passes: readonly PassOutcome[];
  /** Passes the guard threw out. Above zero means a pass in this compiler is wrong. */
  readonly discarded: number;
  readonly before: CircuitShape;
  readonly after: CircuitShape;
}
