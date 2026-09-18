/**
 * Which input assignments get simulated, and how that is described afterwards.
 *
 * This lives on its own because two very different consumers must use the *same* plan:
 * the checks, which decide whether the circuit is right, and the optimizer's equivalence
 * guard, which decides whether a rewrite preserved it. If the guard drew its own
 * assignments, a pass could be accepted on evidence the circuit was never judged against,
 * and the report's coverage line would be describing only half of what happened.
 *
 * Don't-care assignments are excluded from both for the same reason: the specification
 * says nothing about them, so neither the circuit nor a rewrite of it can be wrong there.
 */
import type { ClassicalModule } from '../ir/classical.js';
import { EXHAUSTIVE_INPUT_LIMIT } from '../ir/classical.js';
import { Rng } from '../util/rng.js';
import type { Coverage } from './report.js';

export interface PlanOptions {
  /** Sample count when the input space is too large to enumerate. */
  readonly sampleCount?: number;
  readonly seed?: number;
  readonly exhaustiveLimit?: number;
}

export interface Plan {
  readonly assignments: number[];
  readonly coverage: Coverage;
}

/** Sample size when the caller names none — 4096 assignments is one exhaustive sweep. */
export const DEFAULT_SAMPLE_COUNT = 4096;

export function planAssignments(module: ClassicalModule, options: PlanOptions): Plan {
  const n = module.inputs.length;
  const space = 2 ** n;
  const dontCare = new Set(module.dontCare);
  const limit = options.exhaustiveLimit ?? EXHAUSTIVE_INPUT_LIMIT;

  if (n <= limit) {
    const assignments: number[] = [];
    for (let a = 0; a < space; a++) if (!dontCare.has(a)) assignments.push(a);
    return {
      assignments,
      coverage: { mode: 'exhaustive', checked: assignments.length, space, dontCare: dontCare.size },
    };
  }

  // Above the limit the space cannot be enumerated inside a request. Sample it, and
  // record the seed and the count so the claim is reproducible rather than a promise.
  const seed = options.seed ?? 1;
  const rng = new Rng(seed);
  const wanted = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const seen = new Set<number>();
  const assignments: number[] = [];
  // Bounded attempts: with a near-total don't-care set, rejection sampling would spin.
  for (let attempts = 0; attempts < wanted * 4 && assignments.length < wanted; attempts++) {
    let a = 0;
    for (let bit = 0; bit < n; bit++) if (rng.bit() === 1) a += 2 ** bit;
    if (dontCare.has(a) || seen.has(a)) continue;
    seen.add(a);
    assignments.push(a);
  }
  return {
    assignments,
    coverage: { mode: 'sampled', checked: assignments.length, space, dontCare: dontCare.size, seed },
  };
}
