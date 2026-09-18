/**
 * The gate diff.
 *
 * The case worth testing is the one a positional comparison gets wrong: a gate inserted in
 * the middle. Everything after the insertion shifts by one, and a naive diff reports the
 * whole tail as changed — which is technically true of the indices and false about the
 * circuit.
 */
import { describe, expect, it } from 'vitest';
import { diffGates, LIMIT } from '../src/lib/diff';

describe('diffGates', () => {
  it('reports nothing for identical gate lists', () => {
    const gates = ['Toffoli a b anc0', 'CNOT anc0 out'];
    const result = diffGates(gates, gates);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.rows.every((row) => row.op === 'same')).toBe(true);
  });

  it('reports a mid-list insertion as one added gate, not as a shifted tail', () => {
    const before = ['a', 'b', 'c'];
    const after = ['a', 'x', 'b', 'c'];
    const result = diffGates(before, after);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.rows.filter((row) => row.op === 'added').map((row) => row.text)).toEqual(['x']);
  });

  it('reports a removal', () => {
    const result = diffGates(['a', 'b', 'c'], ['a', 'c']);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.rows.filter((row) => row.op === 'removed').map((row) => row.text)).toEqual(['b']);
  });

  it('handles an empty side', () => {
    expect(diffGates([], ['a', 'b']).added).toBe(2);
    expect(diffGates(['a', 'b'], []).removed).toBe(2);
  });

  it('keeps the original index of each row on the side it came from', () => {
    const result = diffGates(['a', 'b'], ['a', 'x', 'b']);
    const added = result.rows.find((row) => row.op === 'added')!;
    expect(added.indexB).toBe(1);
    expect(added.indexA).toBe(null);
  });

  it('says it truncated rather than locking up on a large pair', () => {
    const big = new Array<string>(LIMIT + 1).fill('g');
    const result = diffGates(big, big);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(0);
  });
});
