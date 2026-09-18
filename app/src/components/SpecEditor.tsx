/**
 * The specification editor.
 *
 * CodeMirror 6 rather than Monaco: the workbench is served from a CDN and Monaco is an
 * order of magnitude larger for an editor that needs line numbers, a gutter, and error
 * markers — no IntelliSense, no language server.
 *
 * Two behaviours matter more than the editing itself:
 *
 *   1. **Compiler errors land on their line.** `QsynthError` carries a source span all the
 *      way through the API (`details.span`), so a `PARSE_ERROR` or `UNSUPPORTED_CONSTRUCT`
 *      becomes a lint diagnostic at that exact position rather than a message floating
 *      above a text box. The gutter marker carries a glyph as well as a colour.
 *   2. **The editor is a link target.** Hovering a gate in the diagram or a line in the
 *      trace highlights the source that produced it; that arrives here as `highlight`.
 *
 * CodeMirror is an uncontrolled editor with its own document state. The `value` prop is
 * pushed in only when it differs from what the editor already holds — otherwise every
 * keystroke would round-trip through React and fight the cursor.
 */
import { useEffect, useRef } from 'react';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, highlightActiveLine, placeholder, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import type { Span } from '../lib/types';

/** Highlight one line, or none. Set by the diagram and the trace console. */
const setHighlight = StateEffect.define<number | null>();

const highlightMark = Decoration.line({ class: 'qs-cm-linked' });

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setHighlight)) continue;
      const line = effect.value;
      if (line === null || line < 1 || line > tr.state.doc.lines) {
        next = Decoration.none;
      } else {
        next = Decoration.set([highlightMark.range(tr.state.doc.line(line).from)]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Clamp a 1-based span onto the document, so a stale span cannot throw. */
function offsetOf(state: EditorState, span: Span): { from: number; to: number } {
  const lineNo = Math.min(Math.max(span.line, 1), state.doc.lines);
  const line = state.doc.line(lineNo);
  const from = Math.min(line.from + Math.max(span.column - 1, 0), line.to);
  const to = Math.min(from + Math.max(span.length ?? 1, 1), line.to);
  return { from, to: to > from ? to : Math.min(from + 1, state.doc.length) };
}

function extensions(onChange: (value: string) => void, readOnly: boolean, hint: string): Extension[] {
  return [
    lineNumbers(),
    lintGutter(),
    history(),
    highlightActiveLine(),
    highlightField,
    placeholder(hint),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
  ];
}

export interface EditorMarker {
  readonly span: Span;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

export function SpecEditor({
  value,
  onChange,
  markers = [],
  highlight = null,
  readOnly = false,
  hint = '',
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  markers?: readonly EditorMarker[];
  highlight?: number | null;
  readOnly?: boolean;
  hint?: string;
  label: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const instance = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: extensions((next) => latestOnChange.current(next), readOnly, hint),
      }),
      parent: host.current,
    });
    // The editable surface is a `contenteditable` div; without these it is an unlabelled
    // text region to a screen reader.
    instance.contentDOM.setAttribute('aria-label', label);
    instance.contentDOM.setAttribute('role', 'textbox');
    instance.contentDOM.setAttribute('aria-multiline', 'true');
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // Mount once. `value` is synchronised by the effect below; rebuilding the editor on
    // every keystroke would discard the undo history and the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    if (instance.state.doc.toString() === value) return;
    instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const diagnostics: Diagnostic[] = markers.map((marker) => ({
      ...offsetOf(instance.state, marker.span),
      severity: marker.severity,
      message: marker.message,
    }));
    instance.dispatch(setDiagnostics(instance.state, diagnostics));
  }, [markers]);

  useEffect(() => {
    view.current?.dispatch({ effects: setHighlight.of(highlight) });
  }, [highlight]);

  return <div ref={host} className="h-full min-h-0 overflow-auto text-sm" />;
}
