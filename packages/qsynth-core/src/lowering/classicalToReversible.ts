/**
 * Classical IR → Reversible IR, by Bennett embedding.
 *
 * The shape is compute / copy-out / uncompute:
 *
 *   1. one input wire per declared input, never written to
 *   2. one ancilla per live node, computed from its operands
 *   3. one output wire per declared output, receiving a CNOT from the node that
 *      defines it
 *   4. the entire compute phase run backwards, returning every ancilla to |0⟩
 *
 * Garbage-freedom is therefore structural: it is not a property we check for and then
 * repair, it is a property of the construction. Check 4 exists to catch a bug in *this
 * file*, not to clean up after it.
 *
 * The cost is one ancilla per node and a doubled gate count. Ancilla reuse and
 * partial uncomputation are optimization passes (FR-3), which run behind an
 * equivalence guard precisely because they trade this structural guarantee for size.
 *
 * Every operator below is a permutation on the operand wires plus a fresh |0⟩ target.
 * The comments state the resulting target value; that claim is what the per-operator
 * unit tests check exhaustively.
 */
import type { ClassicalModule, ClassicalNode } from '../ir/classical.js';
import { liveNodes } from '../ir/classical.js';
import { CircuitBuilder, targetsOf, type ReversibleCircuit } from '../ir/reversible.js';
import { assertInvariant } from '../errors.js';
import type { TraceRecorder } from '../trace/trace.js';

export interface LoweringResult {
  readonly circuit: ReversibleCircuit;
  /** Classical node id → wire holding its value during the compute phase. */
  readonly nodeWire: ReadonlyMap<number, number>;
}

export function lowerToReversible(module: ClassicalModule, trace: TraceRecorder): LoweringResult {
  const builder = new CircuitBuilder(module.name);
  const nodeWire = new Map<number, number>();
  const live = liveNodes(module);

  for (const input of module.inputs) {
    const wire = builder.addInput(input.name);
    nodeWire.set(input.id, wire);
    trace.add({
      phase: 'lower',
      kind: 'wire.input',
      message: `Input "${input.name}" occupies wire ${wire}, and is never written to.`,
      nodeId: input.id,
      wires: [wire],
    });
  }

  const computeStart = builder.gateCount;

  for (const node of module.nodes) {
    if (node.op === 'input') continue;
    if (!live.has(node.id)) {
      trace.add({
        phase: 'lower',
        kind: 'node.dead',
        message: `Node ${node.id} (${node.op}) has no path to any output or assertion, so no wire was allocated for it.`,
        nodeId: node.id,
        span: node.span,
      });
      continue;
    }
    lowerNode(module, node, builder, nodeWire, trace);
  }

  const computeEnd = builder.gateCount;

  // --- copy out -----------------------------------------------------------------
  // The copy has to happen between compute and uncompute: afterwards the ancillas
  // are back to |0⟩ and there is nothing left to copy.
  for (const binding of module.outputs) {
    const source = nodeWire.get(binding.node);
    assertInvariant(source !== undefined, `output "${binding.name}" has no computed wire`);
    const target = builder.addOutput(binding.name);
    const gateIndex = builder.emit('cnot', [source, target], { span: binding.span, nodeId: binding.node });
    trace.add({
      phase: 'lower',
      kind: 'output.copy',
      message: `Output "${binding.name}" is copied onto wire ${target} with a CNOT from wire ${source}.`,
      nodeId: binding.node,
      wires: [source, target],
      gateIndex,
      span: binding.span,
    });
  }

  for (const binding of module.assertions) {
    const source = nodeWire.get(binding.node);
    assertInvariant(source !== undefined, `assertion "${binding.name}" has no computed wire`);
    const target = builder.addOutput(`assert:${binding.name}`);
    const gateIndex = builder.emit('cnot', [source, target], { span: binding.span, nodeId: binding.node });
    trace.add({
      phase: 'lower',
      kind: 'assertion.copy',
      message: `Assertion "${binding.name}" is copied onto wire ${target} so it can be evaluated after the circuit runs.`,
      nodeId: binding.node,
      wires: [source, target],
      gateIndex,
      span: binding.span,
    });
  }

  // --- uncompute ----------------------------------------------------------------
  const uncomputeStart = builder.gateCount;
  builder.emitInverseOf(computeStart, computeEnd);
  const uncomputeEnd = builder.gateCount;

  trace.add({
    phase: 'reversible',
    kind: 'uncompute.block',
    message:
      `The ${computeEnd - computeStart} compute gates are replayed in reverse (gates ` +
      `${uncomputeStart}–${uncomputeEnd - 1}), returning every ancilla to |0⟩. ` +
      'Each gate in this IR is its own inverse, so no separate inverse gates are needed.',
    detail: { computeStart, computeEnd, uncomputeStart, uncomputeEnd },
  });

  const circuit = builder.build();

  // Wires the compute phase actually writes to. A `const 0` node emits no gates, so its
  // ancilla is never dirtied and has no uncompute gate to point at — saying otherwise
  // would put a gate index in the ledger that does not touch that wire.
  const dirtied = new Set<number>();
  for (let i = computeStart; i < computeEnd; i++) {
    for (const w of targetsOf(circuit.gates[i]!)) dirtied.add(w);
  }

  // The mirror position of the gate that created an ancilla's value is the gate that
  // undoes it: compute gate i is undone by gate (uncomputeStart + (computeEnd-1-i)).
  for (const record of circuit.ancillas) {
    const touched = dirtied.has(record.wire);
    const mirror = touched ? uncomputeStart + (computeEnd - 1 - record.allocatedAtGate) : record.allocatedAtGate;
    record.uncomputedAtGate = mirror;
    record.releasedAtGate = uncomputeEnd - 1;
    trace.add({
      phase: 'reversible',
      kind: 'ancilla.ledger',
      message: touched
        ? `Ancilla on wire ${record.wire} (${record.purpose}) is allocated before gate ` +
          `${record.allocatedAtGate}, uncomputed at gate ${mirror}, and released at the end of the circuit.`
        : `Ancilla on wire ${record.wire} (${record.purpose}) is never written to — it holds |0⟩ ` +
          'for the whole circuit, so there is nothing to uncompute.',
      wires: [record.wire],
      nodeId: record.nodeId,
      span: record.span,
      detail: {
        allocatedAtGate: record.allocatedAtGate,
        uncomputedAtGate: mirror,
        releasedAtGate: record.releasedAtGate,
      },
    });
  }

  return { circuit, nodeWire };
}

function lowerNode(
  module: ClassicalModule,
  node: ClassicalNode,
  builder: CircuitBuilder,
  nodeWire: Map<number, number>,
  trace: TraceRecorder,
): void {
  const operand = (i: number): number => {
    const wire = nodeWire.get(node.args[i]!);
    assertInvariant(wire !== undefined, `operand ${node.args[i]} of node ${node.id} has no wire`);
    return wire;
  };

  const record = builder.allocateAncilla(describe(module, node), node.id, node.span);
  const target = record.wire;
  const firstGate = builder.gateCount;
  const emit = (kind: Parameters<CircuitBuilder['emit']>[0], wires: number[]) =>
    builder.emit(kind, wires, { span: node.span, nodeId: node.id });

  // Three primitives, each written as "target ^= …". Every rule below is built from them,
  // and each one collapses when its operands land on the *same wire* — which happens for
  // an expression as ordinary as `a AND a`, or a MUX whose branches share a subexpression.
  // A Toffoli naming one wire twice is not a gate, so the collapse is a correctness
  // requirement, not an optimization: without it the compiler would abort on valid input.

  /** target ^= a */
  const copy = (a: number) => emit('cnot', [a, target]);
  /** target ^= 1 */
  const flip = () => emit('x', [target]);
  /** target ^= a·b — and a·a = a */
  const and2 = (a: number, b: number) => (a === b ? copy(a) : emit('ccnot', [a, b, target]));
  /** target ^= a ⊕ b — and a ⊕ a = 0, so nothing is emitted */
  const xor2 = (a: number, b: number) => {
    if (a === b) return;
    copy(a);
    copy(b);
  };

  switch (node.op) {
    case 'const':
      // |0⟩ already holds 0; only a 1 needs a gate.
      if (node.value === 1) flip();
      break;

    case 'not':
      copy(operand(0));
      flip();
      break;

    case 'and':
      and2(operand(0), operand(1));
      break;

    case 'nand':
      and2(operand(0), operand(1));
      flip();
      break;

    case 'xor':
      xor2(operand(0), operand(1));
      break;

    case 'xnor':
      xor2(operand(0), operand(1));
      flip();
      break;

    case 'or':
      // a ∨ b = ab ⊕ a ⊕ b. Cheaper than De Morgan, which would need two extra ancillas
      // to hold the negated operands. When a = b it degenerates to `target ^= a`, which
      // is exactly a ∨ a.
      and2(operand(0), operand(1));
      xor2(operand(0), operand(1));
      break;

    case 'nor':
      and2(operand(0), operand(1));
      xor2(operand(0), operand(1));
      flip();
      break;

    case 'mux': {
      // mux(s, x, y) = y ⊕ s·x ⊕ s·y. Holds in every coincidence too: with x = y the two
      // products cancel and the target takes y; with s = y it reduces to s·x; with s = x
      // to s ∨ y. The per-operator tests check all of these exhaustively.
      const [s, x, y] = [operand(0), operand(1), operand(2)];
      copy(y);
      and2(s, x);
      and2(s, y);
      break;
    }

    default:
      assertInvariant(false, `no lowering rule for ${node.op}`);
  }

  nodeWire.set(node.id, target);
  trace.add({
    phase: 'lower',
    kind: 'node.lower',
    message:
      `${describe(module, node)} is computed onto ancilla wire ${target} using ` +
      `${builder.gateCount - firstGate} gate(s).`,
    nodeId: node.id,
    wires: [target, ...node.args.map((a) => nodeWire.get(a)!)],
    gateIndex: firstGate,
    span: node.span,
    detail: { op: node.op, gates: builder.gateCount - firstGate },
  });
}

function describe(module: ClassicalModule, node: ClassicalNode): string {
  if (node.name) return `"${node.name}" (${node.op})`;
  const output = module.outputs.find((o) => o.node === node.id);
  if (output) return `output "${output.name}" (${node.op})`;
  return `intermediate ${node.op} at node ${node.id}`;
}
