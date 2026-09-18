/**
 * Status, rendered so that colour is never the only carrier.
 *
 * Each state is a glyph + a word + a colour. Drop the colour (monochrome print, a
 * colour-blind reader, a high-contrast forced-colours mode) and the glyph and the word
 * still say which one it is — which is the whole requirement behind "status is never
 * encoded by colour alone".
 *
 * The glyphs are text, not icon fonts or inline SVG, so they survive a screen reader
 * reading the row and a user copying it. They are marked `aria-hidden` because the word
 * next to them already says it; announcing "check mark passed" twice is noise.
 */
import type { CheckStatus } from '../lib/types';

export type Tone = 'verified' | 'warning' | 'failed' | 'neutral';

const TONES: Record<Tone, { className: string; glyph: string }> = {
  verified: { className: 'text-verified border-verified', glyph: '✓' },
  warning: { className: 'text-warning border-warning', glyph: '!' },
  failed: { className: 'text-failed border-failed', glyph: '✕' },
  neutral: { className: 'text-ink-faint border-rule-strong', glyph: '·' },
};

export function toneForCheck(status: CheckStatus): Tone {
  if (status === 'passed') return 'verified';
  if (status === 'failed') return 'failed';
  return 'neutral';
}

export function StatusBadge({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  const { className, glyph } = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs font-mono uppercase tracking-wider ${className}`}
      {...(title ? { title } : {})}
    >
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
}

/** The inline form, for use inside a sentence or a table cell. */
export function StatusText({ tone, label }: { tone: Tone; label: string }) {
  const { className, glyph } = TONES[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 ${className.split(' ')[0]}`}>
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
}
