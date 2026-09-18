/**
 * A type-level bridge between the compiler's own types and the ones the workbench declares.
 *
 * The SPA in `app/` cannot import the core package at runtime — it talks to the API over
 * HTTP and is built by a separate toolchain — so its `lib/types.ts` is a hand-written
 * restatement of what the wire carries. A restatement drifts. It drifted once already: the
 * optimizer summary there said `{pass, outcome, before: number}` while the server had been
 * sending `{id, status, before: CircuitShape}` for two phases. Every test passed, because
 * every test was fed the same wrong shape by the same hand-written fixture; the first real
 * compile in a browser rendered an object as a React child and blanked the page.
 *
 * So: this file imports both sides and asserts, at compile time, that a server value is
 * assignable to the app's view of it. It declares no values and runs nothing. It lives at
 * the root rather than in `app/` because the core's sources are written against this
 * tsconfig; compiling them under the app's stricter one would report the package's
 * settings rather than the contract. `npm run typecheck` is where the next drift fails.
 *
 * Assignability is one-directional on purpose. The app's types may be looser in the fields
 * they bother to name — they are a view, not a mirror — but they may never claim a field
 * the server does not send, or claim a shape it does not have.
 *
 * Only the shapes the app actually destructures are pinned. The identity and pagination
 * payloads are assembled by the API routes rather than by the core, and have no type here
 * to compare against; they are covered by the integration tests instead.
 */
import type {
  CheckResult as CoreCheckResult,
  CliffordTFigures as CoreCliffordT,
  Coverage as CoreCoverage,
  Gate as CoreGate,
  OptimizationSummary as CoreOptimization,
  PassOutcome as CorePassOutcome,
  ResourceEstimate as CoreResourceEstimate,
  ReversibleCircuit as CoreCircuit,
  TraceEntry as CoreTraceEntry,
} from '@qsynth/core';
import type {
  CheckResult,
  Coverage,
  OptimizationSummary,
  PassOutcome,
  Resources,
  ReversibleCircuit,
  ReversibleGate,
  TraceEntry,
} from '../app/src/lib/types';

/** Fails to compile if `From` is not assignable to `To`. */
type Assignable<To, From extends To> = [To, From];

export type _Optimization = Assignable<OptimizationSummary, CoreOptimization>;
export type _PassOutcome = Assignable<PassOutcome, CorePassOutcome>;
export type _Coverage = Assignable<Coverage, CoreCoverage>;
export type _Check = Assignable<CheckResult, CoreCheckResult>;
export type _Circuit = Assignable<ReversibleCircuit, CoreCircuit>;
export type _Gate = Assignable<ReversibleGate, CoreGate>;
export type _Trace = Assignable<TraceEntry, CoreTraceEntry>;

/**
 * Resources are the one payload the API reshapes on the way out — the estimate is stored
 * flat and served as a `measured`/`cliffordT` pair, so the two halves are pinned
 * separately against the estimate they are split from.
 */
export type _Measured = Assignable<Resources['measured'], CoreResourceEstimate>;
export type _CliffordT = Assignable<Resources['cliffordT'], CoreCliffordT>;
