/**
 * Bounded unsigned integers, built out of single-bit Classical IR nodes.
 *
 * The Classical IR is bit-only on purpose — one lowering rule per operator instead of one
 * per operator per width — so this is the layer where a `uint4` exists. A value is a
 * little-endian list of node ids, index 0 being the least significant bit, and every
 * arithmetic operator below is a textbook construction over that list.
 *
 * **Nothing here folds constants.** Zero-extending `a: uint2` to meet `b: uint4` produces
 * two `const 0` nodes, and adding them emits real gates that are provably removable. That
 * is deliberate, and it matches the rule the Boolean frontend already follows: a frontend
 * that quietly optimized would make the optimizer's reported savings a fiction. The
 * constant-folding pass removes them, with before/after figures the user can read, behind
 * the equivalence guard. The one thing this file does for free is *rewiring* — shifts,
 * slices and indexing move bits between positions without emitting a node, because that
 * is what those operators mean, not an optimization of what they mean.
 *
 * Widths follow Python's arithmetic where a circuit can: `+` widens by one so the carry
 * out survives, `<<` widens by the shift amount, and the comparisons produce a bit. What
 * a circuit cannot follow is Python's unbounded `int`, so a value narrowed by an
 * annotation is truncated — and the lowering records that in the trace rather than
 * letting it happen quietly.
 */
import type { Span } from '../../errors.js';
import { assertInvariant } from '../../errors.js';
import type { ModuleBuilder } from '../../ir/classical.js';

/** A bounded unsigned integer: node ids, least significant bit first. */
export interface Bits {
  readonly bits: readonly number[];
}

export const widthOf = (value: Bits): number => value.bits.length;

export const bitsOf = (nodes: readonly number[]): Bits => {
  assertInvariant(nodes.length > 0, 'a value must have at least one bit');
  return { bits: [...nodes] };
};

/** Widen with explicit zero bits. Never narrows — truncation is always deliberate. */
export function zeroExtend(builder: ModuleBuilder, value: Bits, width: number, span?: Span): Bits {
  if (value.bits.length >= width) return value;
  const bits = [...value.bits];
  while (bits.length < width) bits.push(builder.constant(0, span));
  return { bits };
}

/** Narrow by dropping high bits. The caller is expected to have said so out loud. */
export const truncate = (value: Bits, width: number): Bits => ({ bits: value.bits.slice(0, width) });

export function fit(builder: ModuleBuilder, value: Bits, width: number, span?: Span): Bits {
  return value.bits.length > width ? truncate(value, width) : zeroExtend(builder, value, width, span);
}

export function constantBits(builder: ModuleBuilder, value: number, width: number, span?: Span): Bits {
  const bits: number[] = [];
  for (let i = 0; i < width; i++) bits.push(builder.constant(((value >> i) & 1) as 0 | 1, span));
  return { bits };
}

/** The two operands widened to a common width — the one every bitwise operator uses. */
function align(builder: ModuleBuilder, a: Bits, b: Bits, span?: Span): { a: Bits; b: Bits; width: number } {
  const width = Math.max(a.bits.length, b.bits.length);
  return { a: zeroExtend(builder, a, width, span), b: zeroExtend(builder, b, width, span), width };
}

export function bitwise(
  builder: ModuleBuilder,
  op: 'and' | 'or' | 'xor',
  left: Bits,
  right: Bits,
  span?: Span,
  name?: string,
): Bits {
  const { a, b, width } = align(builder, left, right, span);
  const bits: number[] = [];
  for (let i = 0; i < width; i++) bits.push(builder.op(op, [a.bits[i]!, b.bits[i]!], span, name));
  return { bits };
}

export function invert(builder: ModuleBuilder, value: Bits, span?: Span, name?: string): Bits {
  return { bits: value.bits.map((bit) => builder.op('not', [bit], span, name)) };
}

/**
 * Ripple-carry addition, `width = max(a, b) + 1` so the carry out is part of the result.
 *
 * Three nodes per bit rather than the textbook five: the carry is a majority vote, and
 * `majority(a, b, c)` is `mux(a XOR b, c, a)` — when the operand bits differ the carry
 * passes through, and when they agree it *is* the operand bit. The XOR is needed for the
 * sum anyway, so the carry costs one node.
 */
export function add(builder: ModuleBuilder, left: Bits, right: Bits, span?: Span, name?: string): Bits {
  const { a, b, width } = align(builder, left, right, span);
  const bits: number[] = [];
  let carry: number | null = null;

  for (let i = 0; i < width; i++) {
    const x = a.bits[i]!;
    const y = b.bits[i]!;
    const propagate = builder.op('xor', [x, y], span, name);
    if (carry === null) {
      bits.push(propagate);
      carry = builder.op('and', [x, y], span, name);
    } else {
      bits.push(builder.op('xor', [propagate, carry], span, name));
      carry = builder.op('mux', [propagate, carry, x], span, name);
    }
  }
  bits.push(carry!);
  return { bits };
}

/**
 * Subtraction as `a + ~b + 1`, truncated to `max(a, b)` bits — so it wraps, exactly as a
 * fixed-width register does. The final carry is discarded here because it is the *inverse
 * borrow*, and the comparisons below need it in a form that says what it means; they
 * compute it themselves rather than reading a bit whose polarity has to be remembered.
 */
export function subtract(builder: ModuleBuilder, left: Bits, right: Bits, span?: Span, name?: string): Bits {
  const { a, b, width } = align(builder, left, right, span);
  const complement = invert(builder, b, span, name);
  const bits: number[] = [];
  // Carry in of 1 completes the two's complement. Written as a constant node so the
  // adder below is the same construction as `add`, rather than a second one.
  let carry: number = builder.constant(1, span);

  for (let i = 0; i < width; i++) {
    const x = a.bits[i]!;
    const y = complement.bits[i]!;
    const propagate = builder.op('xor', [x, y], span, name);
    bits.push(builder.op('xor', [propagate, carry], span, name));
    carry = builder.op('mux', [propagate, carry, x], span, name);
  }
  return { bits };
}

/**
 * `left < right`, unsigned, as the borrow out of a subtraction.
 *
 * Two nodes per bit: `borrow' = mux(a XNOR b, borrow, b)`. Where the bits agree the borrow
 * propagates; where they differ the borrow is decided outright by `b` — a 1 over a 0
 * borrows, a 0 over a 1 does not.
 */
export function lessThan(builder: ModuleBuilder, left: Bits, right: Bits, span?: Span, name?: string): number {
  const { a, b, width } = align(builder, left, right, span);
  let borrow: number | null = null;
  for (let i = 0; i < width; i++) {
    const x = a.bits[i]!;
    const y = b.bits[i]!;
    if (borrow === null) {
      // The first column has no incoming borrow: it borrows exactly when b is set and a
      // is not.
      borrow = builder.op('and', [builder.op('not', [x], span, name), y], span, name);
      continue;
    }
    const same = builder.op('xnor', [x, y], span, name);
    borrow = builder.op('mux', [same, borrow, y], span, name);
  }
  return borrow!;
}

/** `left == right`, as a balanced AND tree over per-bit XNORs, to keep depth logarithmic. */
export function equals(builder: ModuleBuilder, left: Bits, right: Bits, span?: Span, name?: string): number {
  const { a, b, width } = align(builder, left, right, span);
  let level: number[] = [];
  for (let i = 0; i < width; i++) level.push(builder.op('xnor', [a.bits[i]!, b.bits[i]!], span, name));
  while (level.length > 1) {
    const next: number[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const first = level[i]!;
      const second = level[i + 1];
      next.push(second === undefined ? first : builder.op('and', [first, second], span, name));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * `value != 0`, as a balanced OR tree. This is what Python's truthiness means for an
 * integer, and it is the only honest reading of `if x:` when `x` is more than one bit
 * wide — taking the low bit would be a different program that happens to agree half the
 * time.
 */
export function reduceOr(builder: ModuleBuilder, value: Bits, span?: Span, name?: string): number {
  let level = [...value.bits];
  while (level.length > 1) {
    const next: number[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const first = level[i]!;
      const second = level[i + 1];
      next.push(second === undefined ? first : builder.op('or', [first, second], span, name));
    }
    level = next;
  }
  return level[0]!;
}

/** Per-bit `mux(selector, ifOne, ifZero)`, operands aligned. */
export function select(builder: ModuleBuilder, selector: number, ifOne: Bits, ifZero: Bits, span?: Span, name?: string): Bits {
  const { a, b, width } = align(builder, ifOne, ifZero, span);
  const bits: number[] = [];
  for (let i = 0; i < width; i++) bits.push(builder.op('mux', [selector, a.bits[i]!, b.bits[i]!], span, name));
  return { bits };
}

/**
 * `value << amount`, widening by `amount`. Pure rewiring: the low positions are fresh
 * constant zeros and the rest are the same nodes at higher indices. No gate is emitted,
 * because a shift by a constant is not a computation.
 */
export function shiftLeft(builder: ModuleBuilder, value: Bits, amount: number, span?: Span): Bits {
  if (amount === 0) return value;
  const bits: number[] = [];
  for (let i = 0; i < amount; i++) bits.push(builder.constant(0, span));
  bits.push(...value.bits);
  return { bits };
}

/** `value >> amount`. Bits shifted out are dropped; shifting past the width leaves zero. */
export function shiftRight(builder: ModuleBuilder, value: Bits, amount: number, span?: Span): Bits {
  if (amount === 0) return value;
  const kept = value.bits.slice(amount);
  return kept.length > 0 ? { bits: kept } : { bits: [builder.constant(0, span)] };
}
