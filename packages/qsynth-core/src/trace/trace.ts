/**
 * The explainability trace (FR-6).
 *
 * Entries are appended *during* lowering, by the code making each decision. They are
 * never reconstructed afterwards from the finished circuit — a reconstruction can only
 * report what the output looks like, not why the compiler chose it, and it drifts from
 * the real behaviour the moment the lowering changes without the explainer changing too.
 */
import type { Span } from '../errors.js';

export type TracePhase = 'parse' | 'lower' | 'reversible' | 'verify' | 'emit' | 'estimate' | 'optimize';

export interface TraceEntry {
  readonly seq: number;
  readonly phase: TracePhase;
  /** Machine-readable kind, e.g. 'ancilla.allocate', 'gate.emit', 'ancilla.uncompute'. */
  readonly kind: string;
  /** One sentence a user can read, in terms of their specification. */
  readonly message: string;
  readonly span?: Span;
  readonly nodeId?: number;
  readonly wires?: readonly number[];
  readonly gateIndex?: number;
  readonly detail?: Record<string, unknown>;
}

export class TraceRecorder {
  private readonly entries: TraceEntry[] = [];

  add(entry: Omit<TraceEntry, 'seq'>): void {
    this.entries.push({ seq: this.entries.length, ...entry });
  }

  get length(): number {
    return this.entries.length;
  }

  toArray(): readonly TraceEntry[] {
    return this.entries;
  }

  /** Entries touching a given wire — the workbench uses this for hover-linking. */
  forWire(wire: number): readonly TraceEntry[] {
    return this.entries.filter((e) => e.wires?.includes(wire));
  }
}
