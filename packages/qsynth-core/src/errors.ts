/**
 * Every failure the compiler can produce is a QsynthError.
 *
 * Global Constraint #3 — no silent failures — means a thrown error must answer three
 * questions without the user reading our source: what went wrong (`message`), where
 * (`span`), and what to do about it (`hint`). A bare `throw new Error('bad input')`
 * fails all three, so the class does not allow one.
 */

/** A half-open byte range in the source text, with 1-based line/column for display. */
export interface Span {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export type QsynthErrorCode =
  | 'PARSE_ERROR'
  | 'UNSUPPORTED_CONSTRUCT'
  | 'INVALID_SPEC'
  | 'SPEC_TOO_LARGE'
  | 'BUDGET_EXCEEDED'
  | 'VERIFICATION_FAILED'
  | 'INTERNAL';

export class QsynthError extends Error {
  readonly code: QsynthErrorCode;
  readonly hint: string;
  readonly span: Span | undefined;
  readonly details: Record<string, unknown>;

  constructor(
    code: QsynthErrorCode,
    message: string,
    hint: string,
    options: { span?: Span; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'QsynthError';
    this.code = code;
    this.hint = hint;
    this.span = options.span;
    this.details = options.details ?? {};
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      ...(this.span ? { span: this.span } : {}),
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

export const parseError = (message: string, hint: string, span?: Span) =>
  new QsynthError('PARSE_ERROR', message, hint, { span });

export const unsupported = (construct: string, supported: readonly string[], span?: Span) =>
  new QsynthError(
    'UNSUPPORTED_CONSTRUCT',
    `${construct} is not supported.`,
    `QSYNTH accepts: ${supported.join(', ')}.`,
    { span, details: { construct, supported } },
  );

export const invalidSpec = (message: string, hint: string, details: Record<string, unknown> = {}) =>
  new QsynthError('INVALID_SPEC', message, hint, { details });

/** Internal invariant violation: a bug in the compiler, not in the user's input. */
export function assertInvariant(condition: unknown, what: string): asserts condition {
  if (!condition) {
    throw new QsynthError(
      'INTERNAL',
      `Compiler invariant violated: ${what}.`,
      'This is a bug in QSYNTH. Please report the specification that produced it.',
      { details: { invariant: what } },
    );
  }
}
