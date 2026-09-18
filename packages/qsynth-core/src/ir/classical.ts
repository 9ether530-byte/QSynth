/**
 * Classical IR — a typed SSA dataflow graph over single bits.
 *
 * Every node is pure and references only lower-numbered nodes, so node order *is* a
 * topological order and evaluation is a single forward sweep. There is no control
 * flow: branches from the frontends become `mux`, and loops are unrolled before they
 * reach here. That restriction is what makes the whole pipeline decidable — an
 * unbounded loop has no finite reversible embedding.
 *
 * Bounded integers exist in the frontends (a `uint<N>` is a vector of bit nodes) but
 * not in this IR. Keeping the IR at bit granularity means one lowering rule per
 * operator instead of one per operator per width.
 */
import type { Span } from '../errors.js';
import { assertInvariant, invalidSpec } from '../errors.js';

export type BitOp =
  | 'const'
  | 'input'
  | 'not'
  | 'and'
  | 'or'
  | 'xor'
  | 'nand'
  | 'nor'
  | 'xnor'
  | 'mux';

/** Operand counts, used both by the builder and by the type/shape check (FR-4.1). */
export const ARITY: Record<BitOp, number> = {
  const: 0,
  input: 0,
  not: 1,
  and: 2,
  or: 2,
  xor: 2,
  nand: 2,
  nor: 2,
  xnor: 2,
  mux: 3,
};

export interface ClassicalNode {
  readonly id: number;
  readonly op: BitOp;
  /** Node ids of the operands, each strictly less than `id`. */
  readonly args: readonly number[];
  /** Present only for `const`. */
  readonly value?: 0 | 1;
  /** Present for `input`, and for named intermediates worth showing in the trace. */
  readonly name?: string;
  readonly span?: Span;
}

export interface OutputBinding {
  readonly name: string;
  readonly node: number;
  readonly span?: Span;
}

export interface AssertionBinding {
  readonly name: string;
  /** Must evaluate to 1 for every input assignment in the care set. */
  readonly node: number;
  readonly span?: Span;
}

export interface ClassicalModule {
  readonly name: string;
  readonly inputs: readonly { readonly id: number; readonly name: string }[];
  readonly nodes: readonly ClassicalNode[];
  readonly outputs: readonly OutputBinding[];
  readonly assertions: readonly AssertionBinding[];
  /**
   * Input assignments (as an index into the 2^n assignment space) the specification
   * did not constrain. Equivalence is not checked there — a don't-care row is a row
   * the user declined to specify, and holding the circuit to an invented value would
   * report a failure the user cannot act on.
   */
  readonly dontCare: readonly number[];
}

export const MAX_INPUTS = 20;
/** Above this, equivalence stops being exhaustive; see verify/checks.ts. */
export const EXHAUSTIVE_INPUT_LIMIT = 12;

export class ModuleBuilder {
  private readonly nodes: ClassicalNode[] = [];
  private readonly inputs: { id: number; name: string }[] = [];
  private readonly outputs: OutputBinding[] = [];
  private readonly assertions: AssertionBinding[] = [];
  private readonly dontCare: number[] = [];

  constructor(private readonly name: string) {}

  input(name: string, span?: Span): number {
    if (this.inputs.length >= MAX_INPUTS) {
      throw invalidSpec(
        `A specification may declare at most ${MAX_INPUTS} input bits; this one declares more.`,
        'Split the design into smaller modules, or reduce the input width.',
        { limit: MAX_INPUTS },
      );
    }
    const id = this.nodes.length;
    this.nodes.push({ id, op: 'input', args: [], name, span });
    this.inputs.push({ id, name });
    return id;
  }

  constant(value: 0 | 1, span?: Span): number {
    const id = this.nodes.length;
    this.nodes.push({ id, op: 'const', args: [], value, span });
    return id;
  }

  op(op: BitOp, args: readonly number[], span?: Span, name?: string): number {
    assertInvariant(op !== 'input' && op !== 'const', `op() called with ${op}`);
    assertInvariant(args.length === ARITY[op], `${op} takes ${ARITY[op]} operands, got ${args.length}`);
    const id = this.nodes.length;
    for (const arg of args) assertInvariant(arg >= 0 && arg < id, `operand ${arg} is not defined before node ${id}`);
    this.nodes.push({ id, op, args: [...args], span, name });
    return id;
  }

  output(name: string, node: number, span?: Span): void {
    if (this.outputs.some((o) => o.name === name)) {
      throw invalidSpec(`Output "${name}" is defined more than once.`, 'Rename one of the definitions.', { name });
    }
    this.outputs.push({ name, node, span });
  }

  assertion(name: string, node: number, span?: Span): void {
    this.assertions.push({ name, node, span });
  }

  markDontCare(assignments: readonly number[]): void {
    this.dontCare.push(...assignments);
  }

  build(): ClassicalModule {
    if (this.inputs.length === 0) {
      throw invalidSpec(
        'The specification declares no inputs.',
        'A circuit with no inputs is a constant; declare at least one input bit.',
      );
    }
    if (this.outputs.length === 0) {
      throw invalidSpec(
        'The specification defines no outputs.',
        'Assign at least one output, for example: out = a AND b',
      );
    }
    return {
      name: this.name,
      inputs: [...this.inputs],
      nodes: [...this.nodes],
      outputs: [...this.outputs],
      assertions: [...this.assertions],
      dontCare: [...new Set(this.dontCare)].sort((a, b) => a - b),
    };
  }
}

/**
 * Nodes that no output or assertion depends on. Reported rather than removed here —
 * dead-code elimination is an optimization pass (FR-3) with its own before/after
 * accounting, and deleting silently at construction would rob it of anything to report.
 */
export function liveNodes(module: ClassicalModule): Set<number> {
  const live = new Set<number>();
  const stack = [...module.outputs.map((o) => o.node), ...module.assertions.map((a) => a.node)];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (live.has(id)) continue;
    live.add(id);
    const node = module.nodes[id];
    assertInvariant(node !== undefined, `node ${id} referenced but not defined`);
    stack.push(...node.args);
  }
  return live;
}
