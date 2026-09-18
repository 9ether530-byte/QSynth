/**
 * Seeded PRNG — sampling decisions must be reproducible.
 *
 * When equivalence cannot be exhaustive, the report records the seed and the sample
 * count, and re-running with that seed must draw the same assignments. `Math.random()`
 * would make a reported "passed with 4096 samples" unfalsifiable: nobody could reproduce
 * which 4096.
 *
 * mulberry32 — 32-bit state, fast, adequate for choosing test points. Not cryptographic;
 * nothing here needs it to be.
 */
export class Rng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Next uint32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform integer in [0, bound). */
  below(bound: number): number {
    return this.next() % bound;
  }

  bit(): 0 | 1 {
    return (this.next() & 1) as 0 | 1;
  }
}

/** A seed derived from content, so the same spec samples the same points every run. */
export function seedFromHash(hex: string): number {
  return parseInt(hex.slice(0, 8), 16) >>> 0;
}
