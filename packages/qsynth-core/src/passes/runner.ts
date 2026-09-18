/**
 * The optimizer, and the guard that makes it safe to have one (FR-3).
 *
 * The contract is narrow and absolute: **a pass may cost gates, never correctness.** It is
 * enforced by re-deriving the circuit's observable behaviour after every pass and
 * comparing it against the behaviour of the circuit the pipeline started with. A pass that
 * changed anything is discarded outright — not repaired, not partially applied — and the
 * circuit it was handed is carried forward untouched. The rest of the pipeline then runs
 * against a circuit that is, by construction, no different from the unoptimized one.
 *
 * Three decisions worth stating, because each of them could plausibly have gone the other
 * way and each would have weakened the guarantee:
 *
 * **The reference is the original, not the previous circuit.** Comparing each pass against
 * its immediate input would let a chain of passes drift: pass A introduces a difference
 * the guard tolerates because it is comparing to A's output, and pass B is then judged
 * against a circuit that is already wrong. Anchoring every comparison to the circuit that
 * came out of lowering costs nothing — the reference is simulated once — and means the
 * final circuit is checked against the one whose correctness the six checks will certify.
 *
 * **Observation is the circuit's interface, not its whole state.** The guard compares the
 * output wires, the input wires at circuit end, and how many ancillas finished dirty. It
 * deliberately does not compare ancilla wires one by one, because that would forbid
 * `drop-unused-ancillas` from existing: removing a wire that is provably |0⟩ throughout
 * changes the state vector's width while changing nothing anyone can observe. What the
 * comparison does keep is every property the six checks go on to test — the outputs
 * (check 2), the inputs being undisturbed and the ancillas being clean (check 4).
 *
 * **The guard preserves behaviour, it does not judge it.** If the circuit handed to the
 * optimizer is already wrong, the guard will faithfully preserve its wrongness, and check
 * 2 will then fail on the optimized circuit exactly as it would have on the original.
 * That is the correct division of labour: a guard that also tried to decide what the
 * circuit *should* do would be a second implementation of check 2, and two implementations
 * of the same judgement is one more than can be kept in agreement.
 */
import type { ClassicalModule } from '../ir/classical.js';
import type { ReversibleCircuit } from '../ir/reversible.js';
import { depth as circuitDepth } from '../ir/reversible.js';
import { assignmentToBits, type Bit } from '../eval/classical.js';
import { simulate } from '../sim/basisState.js';
import type { Plan } from '../verify/plan.js';
import type { TraceRecorder } from '../trace/trace.js';
import { cancelInverses } from './cancelInverses.js';
import { constantFold } from './constantFold.js';
import { reuseValues } from './reuseValues.js';
import { dropUnusedAncillas } from './dropUnusedAncillas.js';
import type { CircuitShape, OptimizationSummary, Pass, PassDivergence, PassOutcome } from './types.js';

/**
 * The pipeline, in order. Each entry earns its place differently, and two of them earn it
 * rarely — which is worth stating plainly, because a list of passes reads like a list of
 * savings and this one is not:
 *
 *   - `cancel-inverses` almost never fires on a Bennett-lowered circuit. The compute and
 *     uncompute halves of a node are separated by the copy-out that reads the value they
 *     bracket, and that read is exactly what stops the two halves from sliding together.
 *     It is kept for hand-written and re-imported circuits, where the shape is not ours.
 *   - `constant-fold` fires on specifications containing literals, and on nothing else.
 *   - `reuse-values` is the one that pays, and it pays on ordinary specifications: a
 *     sub-expression written twice is lowered twice, and this turns every copy after the
 *     first into a CNOT.
 *   - `drop-unused-ancillas` runs last on purpose — it collects the wires the rewriting
 *     passes stranded, and running it first would find nothing.
 */
export const OPTIMIZATION_PASSES: readonly Pass[] = [
  cancelInverses,
  constantFold,
  reuseValues,
  dropUnusedAncillas,
];

export interface OptimizeOptions {
  /** The same assignment plan the checks will use. */
  readonly plan: Plan;
  readonly passes?: readonly Pass[];
  readonly trace?: TraceRecorder;
}

export interface OptimizationResult {
  readonly circuit: ReversibleCircuit;
  readonly summary: OptimizationSummary;
}

/** What one input assignment makes the circuit do, as far as anyone outside can tell. */
interface Observation {
  readonly outputs: Bit[];
  readonly inputsAtEnd: Bit[];
  readonly dirtyAncillas: number;
}

function observe(circuit: ReversibleCircuit, bits: readonly Bit[]): Observation {
  const result = simulate(circuit, bits);
  return {
    outputs: result.outputs,
    inputsAtEnd: result.inputsAtEnd,
    dirtyAncillas: result.ancillasAtEnd.reduce<number>((n, value) => n + (value === 0 ? 0 : 1), 0),
  };
}

function shapeOf(circuit: ReversibleCircuit): CircuitShape {
  return { qubits: circuit.wires.length, gates: circuit.gates.length, depth: circuitDepth(circuit) };
}

function named(names: readonly { readonly name: string }[], bits: readonly Bit[]): Record<string, Bit> {
  const record: Record<string, Bit> = {};
  names.forEach((entry, i) => (record[entry.name] = bits[i]!));
  return record;
}

/**
 * The first assignment on which `candidate` behaves differently from `reference`, or null
 * if there is none across the whole plan.
 */
function findDivergence(
  module: ClassicalModule,
  reference: readonly Observation[],
  candidate: ReversibleCircuit,
  plan: Plan,
): PassDivergence | null {
  for (let i = 0; i < plan.assignments.length; i++) {
    const assignment = plan.assignments[i]!;
    const bits = assignmentToBits(assignment, module.inputs.length);
    const before = reference[i]!;
    const after = observe(candidate, bits);

    const inputs = named(module.inputs, bits);
    const outputNames = candidate.outputs;

    for (let w = 0; w < before.outputs.length; w++) {
      if (before.outputs[w] !== after.outputs[w]) {
        return {
          assignment,
          inputs,
          expected: named(outputNames, before.outputs),
          observed: named(outputNames, after.outputs),
          detail: `output "${outputNames[w]!.name}" changed from ${before.outputs[w]} to ${after.outputs[w]}.`,
        };
      }
    }

    for (let w = 0; w < before.inputsAtEnd.length; w++) {
      if (before.inputsAtEnd[w] !== after.inputsAtEnd[w]) {
        return {
          assignment,
          inputs,
          expected: named(module.inputs, before.inputsAtEnd),
          observed: named(module.inputs, after.inputsAtEnd),
          detail:
            `input "${module.inputs[w]!.name}" no longer holds its original value at the end of the ` +
            'circuit, so the rewrite broke the Bennett form.',
        };
      }
    }

    if (before.dirtyAncillas !== after.dirtyAncillas) {
      return {
        assignment,
        inputs,
        expected: named(outputNames, before.outputs),
        observed: named(outputNames, after.outputs),
        detail:
          `${after.dirtyAncillas} ancilla(s) finished dirty where ${before.dirtyAncillas} did before the ` +
          'rewrite, so the rewrite leaked or stranded state.',
      };
    }
  }
  return null;
}

export function optimize(module: ClassicalModule, circuit: ReversibleCircuit, options: OptimizeOptions): OptimizationResult {
  const passes = options.passes ?? OPTIMIZATION_PASSES;
  const plan = options.plan;
  const before = shapeOf(circuit);

  // One sweep of the original, reused by every pass. Without this the guard would cost a
  // full simulation of the reference per pass rather than per compile.
  const reference = plan.assignments.map((assignment) =>
    observe(circuit, assignmentToBits(assignment, module.inputs.length)),
  );

  let current = circuit;
  const outcomes: PassOutcome[] = [];

  for (const pass of passes) {
    const started = performance.now();
    const shapeBefore = shapeOf(current);
    const candidate = pass.run(current);
    const shapeAfter = shapeOf(candidate);

    // A pass that found nothing returns the circuit it was given, so identity is the
    // usual answer. The structural comparison is the fallback for a pass that rebuilds an
    // identical circuit — it must not be reported as having optimized anything, and it
    // must not cost a guard sweep either.
    const unchanged =
      candidate === current ||
      (shapeAfter.gates === shapeBefore.gates &&
        shapeAfter.qubits === shapeBefore.qubits &&
        candidate.gates.every((gate, i) => gate === current.gates[i]));

    if (unchanged) {
      outcomes.push({
        id: pass.id,
        title: pass.title,
        status: 'no_change',
        summary: `${pass.title} found nothing to rewrite.`,
        before: shapeBefore,
        after: shapeAfter,
        durationMs: performance.now() - started,
      });
      continue;
    }

    const divergence = findDivergence(module, reference, candidate, plan);
    if (divergence) {
      outcomes.push({
        id: pass.id,
        title: pass.title,
        status: 'discarded',
        summary:
          `${pass.title} changed what the circuit computes and was discarded; the unoptimized circuit ` +
          `was kept. ${divergence.detail}`,
        before: shapeBefore,
        after: shapeBefore,
        durationMs: performance.now() - started,
        divergence,
      });
      options.trace?.add({
        phase: 'optimize',
        kind: 'pass.discarded',
        message:
          `${pass.title} was discarded: it changed the circuit's behaviour on input assignment ` +
          `${divergence.assignment}. ${divergence.detail} The circuit before the pass was kept, so the ` +
          'result is still correct — but this is a defect in the optimizer.',
        detail: { pass: pass.id, assignment: divergence.assignment },
      });
      continue;
    }

    current = candidate;
    outcomes.push({
      id: pass.id,
      title: pass.title,
      status: 'applied',
      summary:
        `${pass.title}: ${shapeBefore.gates} → ${shapeAfter.gates} gate(s), ` +
        `${shapeBefore.qubits} → ${shapeAfter.qubits} qubit(s), depth ${shapeBefore.depth} → ${shapeAfter.depth}.`,
      before: shapeBefore,
      after: shapeAfter,
      durationMs: performance.now() - started,
    });
    options.trace?.add({
      phase: 'optimize',
      kind: 'pass.applied',
      // No durations in the trace: it is stored as a content-addressed artifact, and a
      // wall-clock number would give the same compilation a different hash every run.
      message:
        `${pass.title} removed ${shapeBefore.gates - shapeAfter.gates} gate(s) and ` +
        `${shapeBefore.qubits - shapeAfter.qubits} qubit(s). ${pass.rationale} The rewrite was re-checked ` +
        `against the unoptimized circuit on ${plan.coverage.checked} input assignment(s) before being kept.`,
      detail: { pass: pass.id, before: shapeBefore, after: shapeAfter },
    });
  }

  return {
    circuit: current,
    summary: {
      guard: {
        mode: plan.coverage.mode,
        checked: plan.coverage.checked,
        space: plan.coverage.space,
        ...(plan.coverage.seed === undefined ? {} : { seed: plan.coverage.seed }),
      },
      passes: outcomes,
      discarded: outcomes.filter((o) => o.status === 'discarded').length,
      before,
      after: shapeOf(current),
    },
  };
}
