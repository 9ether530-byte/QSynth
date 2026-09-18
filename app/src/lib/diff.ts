/**
 * A gate-level diff between two circuits.
 *
 * Plain Myers-style LCS over gate signatures. Two circuits that differ by an inserted
 * subexpression differ by a *run* of gates, not by an offset — a positional comparison
 * would report every gate after the insertion as changed, which is true and useless.
 *
 * The table is O(n·m), so it is bounded: above `LIMIT` gates the diff reports counts only
 * and says so rather than locking the tab. A silent fallback would be worse than a stated
 * one.
 */
export const LIMIT = 1200;

export type Op = 'same' | 'added' | 'removed';

export interface DiffRow {
  readonly op: Op;
  readonly text: string;
  readonly indexA: number | null;
  readonly indexB: number | null;
}

export interface DiffResult {
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
  readonly truncated: boolean;
}

export function diffGates(a: readonly string[], b: readonly string[]): DiffResult {
  if (a.length > LIMIT || b.length > LIMIT) {
    return { rows: [], added: Math.max(0, b.length - a.length), removed: Math.max(0, a.length - b.length), truncated: true };
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ op: 'same', text: a[i]!, indexA: i, indexB: j });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ op: 'removed', text: a[i]!, indexA: i, indexB: null });
      removed++;
      i++;
    } else {
      rows.push({ op: 'added', text: b[j]!, indexA: null, indexB: j });
      added++;
      j++;
    }
  }
  for (; i < a.length; i++, removed++) rows.push({ op: 'removed', text: a[i]!, indexA: i, indexB: null });
  for (; j < b.length; j++, added++) rows.push({ op: 'added', text: b[j]!, indexA: null, indexB: j });

  return { rows, added, removed, truncated: false };
}
