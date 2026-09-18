/**
 * The verification report (FR-4) — the only thing the export gate consults.
 *
 * Two properties this shape is built to guarantee:
 *
 *   - A report can never be *partially* reassuring. `checksReached` lists the checks that
 *     actually ran; anything not in it was skipped by a short-circuit and is reported as
 *     `skipped`, never as absent-and-therefore-fine.
 *   - A failure is always actionable. Every failing check carries structured evidence —
 *     for equivalence that is a concrete counterexample, for budgets the declared and
 *     actual figures — so "it failed" is never the whole message.
 *
 * `passed` is a derived field, not a settable one: it is true only when every check that
 * ran passed and no check was skipped for a reason other than "nothing to check".
 */
import type { Bit } from '../eval/classical.js';

export type CheckId =
  | 'type_shape'
  | 'simulation_equivalence'
  | 'reversibility'
  | 'garbage_free'
  | 'property'
  | 'resource';

export const CHECK_ORDER: readonly CheckId[] = [
  'type_shape',
  'simulation_equivalence',
  'reversibility',
  'garbage_free',
  'property',
  'resource',
];

export const CHECK_TITLES: Record<CheckId, string> = {
  type_shape: 'Type and shape',
  simulation_equivalence: 'Simulation equivalence',
  reversibility: 'Reversibility',
  garbage_free: 'Garbage-free ancillas',
  property: 'Declared properties',
  resource: 'Resource budgets',
};

export type CheckStatus = 'passed' | 'failed' | 'skipped';

/** How thoroughly the input space was covered (FR-4.2). */
export interface Coverage {
  readonly mode: 'exhaustive' | 'sampled';
  /** Assignments actually simulated. */
  readonly checked: number;
  /** Size of the full input space, 2^inputs. */
  readonly space: number;
  /** Assignments skipped because the specification left them unconstrained. */
  readonly dontCare: number;
  /** Present for `sampled` only; re-running with it draws the same assignments. */
  readonly seed?: number;
}

export interface Counterexample {
  /** Input name → value, so the user reads their own names, not wire indices. */
  readonly inputs: Record<string, Bit>;
  readonly expected: Record<string, Bit>;
  readonly observed: Record<string, Bit>;
  /** The assignment index, for reproducing directly. */
  readonly assignment: number;
}

export interface CheckResult {
  readonly id: CheckId;
  readonly title: string;
  readonly status: CheckStatus;
  /** One sentence stating what was established, or what went wrong. */
  readonly summary: string;
  readonly durationMs: number;
  readonly coverage?: Coverage;
  readonly counterexample?: Counterexample;
  /** Check-specific evidence: per-ancilla results, budget figures, property verdicts. */
  readonly evidence?: Record<string, unknown>;
}

export interface VerificationReport {
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  /** Checks that ran, in order. A short-circuit leaves the rest out. */
  readonly checksReached: readonly CheckId[];
  /** Set when a check failed and stopped the run. */
  readonly stoppedAt?: CheckId;
  readonly durationMs: number;
  /** Compiler version and spec hash, so a stored report is attributable. */
  readonly compilerVersion: string;
  readonly specHash: string;
}

export function buildReport(
  results: readonly CheckResult[],
  meta: { compilerVersion: string; specHash: string; durationMs: number },
): VerificationReport {
  const failed = results.find((r) => r.status === 'failed');
  const reached = results.filter((r) => r.status !== 'skipped').map((r) => r.id);
  return {
    passed: failed === undefined,
    checks: results,
    checksReached: reached,
    stoppedAt: failed?.id,
    durationMs: meta.durationMs,
    compilerVersion: meta.compilerVersion,
    specHash: meta.specHash,
  };
}

/** A check that never ran, with the reason stated rather than left blank. */
export function skipped(id: CheckId, reason: string): CheckResult {
  return { id, title: CHECK_TITLES[id], status: 'skipped', summary: reason, durationMs: 0 };
}
