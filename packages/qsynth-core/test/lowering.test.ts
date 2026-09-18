import { describe, expect, it } from 'vitest';
import {
  ARITY,
  assignmentToBits,
  depth,
  evaluate,
  initialState,
  invert,
  lowerBoolean,
  lowerToReversible,
  ModuleBuilder,
  run,
  runRange,
  simulate,
  TraceRecorder,
  type BitOp,
  type ClassicalModule,
  type ReversibleCircuit,
} from '@qsynth/core';

function lower(module: ClassicalModule): ReversibleCircuit {
  return lowerToReversible(module, new TraceRecorder()).circuit;
}

/** One module per operator: n inputs, one output, nothing else. */
function operatorModule(op: BitOp): ClassicalModule {
  const builder = new ModuleBuilder(op);
  const args = Array.from({ length: ARITY[op] }, (_, i) => builder.input(`in${i}`));
  builder.output('out', builder.op(op, args));
  return builder.build();
}

const OPERATORS: BitOp[] = ['not', 'and', 'or', 'xor', 'nand', 'nor', 'xnor', 'mux'];

describe('Bennett lowering, per operator', () => {
  it.each(OPERATORS)('%s computes the specified function on every input, exhaustively', (op) => {
    const module = operatorModule(op);
    const circuit = lower(module);

    for (let a = 0; a < 2 ** module.inputs.length; a++) {
      const bits = assignmentToBits(a, module.inputs.length);
      const result = simulate(circuit, bits);
      expect(result.outputs[0], `${op} on ${bits.join('')}`).toBe(evaluate(module, bits).outputs.out);
    }
  });

  it.each(OPERATORS)('%s leaves every ancilla at zero and every input untouched', (op) => {
    const module = operatorModule(op);
    const circuit = lower(module);

    for (let a = 0; a < 2 ** module.inputs.length; a++) {
      const bits = assignmentToBits(a, module.inputs.length);
      const result = simulate(circuit, bits);
      expect(result.ancillasAtEnd).toEqual(circuit.ancillas.map(() => 0));
      expect(result.inputsAtEnd).toEqual(bits);
    }
  });

  /**
   * Found by the property suite: `a AND a` puts both Toffoli controls on one wire, which
   * is not a gate at all. Every operator has to survive its operands coinciding, because
   * nothing in the language stops a user writing it — and a shared subexpression makes it
   * happen without anyone writing it twice.
   */
  describe('when two operands are the same wire', () => {
    const SAME_OPERAND: readonly { op: BitOp; args: readonly number[]; expected: (a: 0 | 1) => 0 | 1 }[] = [
      { op: 'and', args: [0, 0], expected: (a) => a },
      { op: 'nand', args: [0, 0], expected: (a) => (a ^ 1) as 0 | 1 },
      { op: 'or', args: [0, 0], expected: (a) => a },
      { op: 'nor', args: [0, 0], expected: (a) => (a ^ 1) as 0 | 1 },
      { op: 'xor', args: [0, 0], expected: () => 0 },
      { op: 'xnor', args: [0, 0], expected: () => 1 },
      { op: 'mux', args: [0, 1, 1], expected: () => 0 }, // branches equal: takes the branch
      { op: 'mux', args: [0, 0, 1], expected: (a) => a }, // selector is the "then" branch: a OR y
      { op: 'mux', args: [0, 1, 0], expected: () => 0 }, // selector is the "else" branch: a AND x
      { op: 'mux', args: [0, 0, 0], expected: (a) => a },
    ];

    it.each(SAME_OPERAND)('$op with operands $args computes the right function', ({ op, args, expected }) => {
      const builder = new ModuleBuilder(`${op}_same`);
      const a = builder.input('a');
      const b = builder.input('b');
      const wires = [a, b];
      builder.output('out', builder.op(op, args.map((i) => wires[i]!)));
      const module = builder.build();
      const circuit = lower(module);

      for (let assignment = 0; assignment < 4; assignment++) {
        const bits = assignmentToBits(assignment, 2);
        const result = simulate(circuit, bits);
        // `b` is fixed at 0 in the expectations: every case above ties the operator's
        // remaining operand to wire `a`, so only `a` varies the answer.
        if (bits[1] === 0) expect(result.outputs[0], `${op}(${args}) on a=${bits[0]}`).toBe(expected(bits[0]!));
        expect(result.ancillasAtEnd.every((v) => v === 0)).toBe(true);
        expect(result.inputsAtEnd).toEqual(bits);
      }
    });

    it('emits no gate that names a wire twice, anywhere in the circuit', () => {
      const module = lowerBoolean('in a, b\nlet s = a AND b\nout = MUX(s, s, s) XOR (a AND a)');
      for (const gate of lower(module).gates) {
        expect(new Set(gate.wires).size, `${gate.kind} on ${gate.wires}`).toBe(gate.wires.length);
      }
    });

    it('costs nothing to emit for a XOR a — the target is already zero', () => {
      const builder = new ModuleBuilder('self_xor');
      const a = builder.input('a');
      builder.output('out', builder.op('xor', [a, a]));
      const circuit = lower(builder.build());
      expect(circuit.gates.filter((g) => g.kind !== 'cnot' || g.wires[1] !== circuit.outputs[0]!.wire)).toHaveLength(0);
    });
  });

  it('uses one Toffoli for AND and none for XOR — the cost model the estimate depends on', () => {
    const and = lower(operatorModule('and'));
    const xor = lower(operatorModule('xor'));
    expect(and.gates.filter((g) => g.kind === 'ccnot')).toHaveLength(2); // compute + uncompute
    expect(xor.gates.filter((g) => g.kind === 'ccnot')).toHaveLength(0);
  });
});

describe('circuit structure', () => {
  const module = lowerBoolean('in a, b, c\nout = (a AND b) XOR c');
  const circuit = lower(module);

  it('never writes to an input wire', () => {
    const inputWires = new Set(circuit.inputs.map((i) => i.wire));
    for (const gate of circuit.gates) {
      const targets = gate.kind === 'cswap' ? gate.wires.slice(1) : gate.wires.slice(-1);
      for (const w of targets) expect(inputWires.has(w)).toBe(false);
    }
  });

  it('allocates one ancilla per live node', () => {
    const liveOperations = module.nodes.filter((n) => n.op !== 'input').length;
    expect(circuit.ancillas).toHaveLength(liveOperations);
  });

  it('is its own inverse when run forwards then backwards', () => {
    const start = initialState(circuit, [1, 1, 0]);
    const state = Uint8Array.from(start);
    run(circuit, state);
    run(invert(circuit), state);
    expect([...state]).toEqual([...start]);
  });

  it('reports depth no greater than the gate count and no less than one layer', () => {
    expect(depth(circuit)).toBeGreaterThan(0);
    expect(depth(circuit)).toBeLessThanOrEqual(circuit.gates.length);
  });
});

describe('ancilla ledger', () => {
  const module = lowerBoolean('in a, b, c\nout = (a AND b) OR c');
  const trace = new TraceRecorder();
  const { circuit } = lowerToReversible(module, trace);

  it('records an uncompute point for every ancilla', () => {
    for (const record of circuit.ancillas) {
      expect(record.uncomputedAtGate, record.purpose).not.toBeNull();
      expect(record.releasedAtGate).not.toBeNull();
    }
  });

  it('the recorded uncompute gate is the one that actually clears the wire', () => {
    // The ledger is only useful if its gate indices are true. Run to just before the
    // recorded gate and to just after it, and check the wire changes from dirty to clean.
    const bits = assignmentToBits(0b011, 3); // a=1, b=1 → the AND ancilla is genuinely 1
    let dirtyFound = false;
    for (const record of circuit.ancillas) {
      const uncompute = record.uncomputedAtGate!;
      const before = runRange(circuit, initialState(circuit, bits), 0, uncompute);
      const after = runRange(circuit, initialState(circuit, bits), 0, uncompute + 1);
      expect(after[record.wire], `wire ${record.wire} after gate ${uncompute}`).toBe(0);
      // At least one ancilla must actually have been dirty, or the test proves nothing.
      if (before[record.wire] === 1) dirtyFound = true;
    }
    expect(dirtyFound).toBe(true);
  });

  it('explains each ancilla in the trace, with its source span', () => {
    const entries = trace.toArray().filter((e) => e.kind === 'ancilla.ledger');
    expect(entries).toHaveLength(circuit.ancillas.length);
    expect(entries[0]!.message).toContain('uncomputed at gate');
    expect(entries.some((e) => e.span !== undefined)).toBe(true);
  });

  it('records the uncompute block as one decision, not one entry per gate', () => {
    const block = trace.toArray().filter((e) => e.kind === 'uncompute.block');
    expect(block).toHaveLength(1);
    expect(block[0]!.detail).toMatchObject({ computeStart: 0 });
  });
});

describe('dead code', () => {
  it('allocates no wire for a node nothing depends on, and says so in the trace', () => {
    const builder = new ModuleBuilder('dead');
    const a = builder.input('a');
    const b = builder.input('b');
    builder.op('and', [a, b]); // never used
    builder.output('out', builder.op('xor', [a, b]));
    const module = builder.build();

    const trace = new TraceRecorder();
    const { circuit } = lowerToReversible(module, trace);

    expect(circuit.ancillas).toHaveLength(1);
    const dead = trace.toArray().filter((e) => e.kind === 'node.dead');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.message).toContain('no path to any output');
  });
});

describe('constants', () => {
  it('emits no gate for a constant 0 and reports it as never written', () => {
    const builder = new ModuleBuilder('const-zero');
    const a = builder.input('a');
    builder.output('out', builder.op('and', [a, builder.constant(0)]));
    const module = builder.build();

    const trace = new TraceRecorder();
    const { circuit } = lowerToReversible(module, trace);

    const zeroAncilla = circuit.ancillas.find((r) => r.purpose.includes('const'));
    expect(zeroAncilla).toBeDefined();
    expect(trace.toArray().some((e) => e.kind === 'ancilla.ledger' && e.message.includes('never written'))).toBe(true);

    for (const bit of [0, 1] as const) {
      expect(simulate(circuit, [bit]).outputs[0]).toBe(0);
    }
  });
});

describe('multi-output and assertion wires', () => {
  const module = lowerBoolean('in a, b\nsum = a XOR b\ncarry = a AND b\nassert sane: sum OR NOT sum');
  const circuit = lower(module);

  it('orders output wires as declared, with assertion wires after them', () => {
    expect(circuit.outputs.map((o) => o.name)).toEqual(['sum', 'carry', 'assert:sane']);
  });

  it('computes each output independently', () => {
    for (let a = 0; a < 4; a++) {
      const bits = assignmentToBits(a, 2);
      const expected = evaluate(module, bits);
      const result = simulate(circuit, bits);
      expect(result.outputs[0]).toBe(expected.outputs.sum);
      expect(result.outputs[1]).toBe(expected.outputs.carry);
      expect(result.outputs[2]).toBe(1); // the invariant holds everywhere
    }
  });
});
