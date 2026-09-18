/**
 * Reference semantics for the Classical IR.
 *
 * This is the oracle every equivalence check compares against, so it is written to be
 * obviously correct rather than fast: one switch, no bit tricks, no caching. If this
 * and the reversible circuit ever disagree, the circuit is wrong — which is only a
 * sound conclusion while this function is the simpler of the two.
 */
import type { ClassicalModule } from '../ir/classical.js';
import { assertInvariant } from '../errors.js';

export type Bit = 0 | 1;

/**
 * Input assignments are addressed by an integer: bit i of `assignment` is the value of
 * `module.inputs[i]`. Input 0 is the least significant bit, so counting 0..2^n-1
 * enumerates the space in a stable, documentable order.
 */
export function assignmentToBits(assignment: number, inputCount: number): Bit[] {
  const bits: Bit[] = [];
  for (let i = 0; i < inputCount; i++) bits.push(((assignment >> i) & 1) as Bit);
  return bits;
}

export function bitsToAssignment(bits: readonly Bit[]): number {
  let value = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i] === 1) value |= 1 << i;
  return value;
}

/** Evaluates every node for one input assignment. Index of the result is the node id. */
export function evaluateNodes(module: ClassicalModule, inputBits: readonly Bit[]): Uint8Array {
  assertInvariant(inputBits.length === module.inputs.length, 'input width mismatch in evaluateNodes');

  const values = new Uint8Array(module.nodes.length);
  let inputIndex = 0;

  for (const node of module.nodes) {
    const a = () => values[node.args[0]!]!;
    const b = () => values[node.args[1]!]!;
    const c = () => values[node.args[2]!]!;

    switch (node.op) {
      case 'input':
        values[node.id] = inputBits[inputIndex++]!;
        break;
      case 'const':
        values[node.id] = node.value ?? 0;
        break;
      case 'not':
        values[node.id] = a() ^ 1;
        break;
      case 'and':
        values[node.id] = a() & b();
        break;
      case 'or':
        values[node.id] = a() | b();
        break;
      case 'xor':
        values[node.id] = a() ^ b();
        break;
      case 'nand':
        values[node.id] = (a() & b()) ^ 1;
        break;
      case 'nor':
        values[node.id] = (a() | b()) ^ 1;
        break;
      case 'xnor':
        values[node.id] = (a() ^ b()) ^ 1;
        break;
      case 'mux':
        // mux(s, x, y) selects x when s is 1. Operand order is (selector, if-one, if-zero).
        values[node.id] = a() === 1 ? b() : c();
        break;
    }
  }

  return values;
}

export interface EvaluatedOutputs {
  readonly outputs: Record<string, Bit>;
  readonly assertions: Record<string, Bit>;
}

export function evaluate(module: ClassicalModule, inputBits: readonly Bit[]): EvaluatedOutputs {
  const values = evaluateNodes(module, inputBits);
  const outputs: Record<string, Bit> = {};
  for (const binding of module.outputs) outputs[binding.name] = values[binding.node] as Bit;
  const assertions: Record<string, Bit> = {};
  for (const binding of module.assertions) assertions[binding.name] = values[binding.node] as Bit;
  return { outputs, assertions };
}

/** Output values in declaration order, as a bit vector. */
export function evaluateOutputVector(module: ClassicalModule, inputBits: readonly Bit[]): Bit[] {
  const values = evaluateNodes(module, inputBits);
  return module.outputs.map((o) => values[o.node] as Bit);
}
