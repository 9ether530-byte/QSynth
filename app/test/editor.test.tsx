/**
 * The editor must not trap the keyboard.
 *
 * This is a regression test with a specific history. The first keyboard-only pass over
 * the deployed workbench pressed Tab fourteen times to walk the page and got fourteen
 * spaces in the specification instead: `indentWithTab` had bound Tab to indentation, so a
 * keyboard user who reached the editor could never leave it. WCAG 2.1.2 calls that a
 * keyboard trap, and no automated check we had would ever have found it — axe inspects
 * the DOM, and the DOM was fine.
 *
 * What is asserted here is the escape hatch, in both directions: Tab indents while the
 * user is editing, and Tab after Escape is left alone so the browser moves focus. The
 * second half is the one that matters; the first is there so a future "just remove the
 * Tab binding" does not quietly take indentation away from the Python subset.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SpecEditor } from '../src/components/SpecEditor';

function editorContent(): HTMLElement {
  return screen.getByRole('textbox', { name: 'boolean specification' });
}

describe('the specification editor', () => {
  it('indents on Tab while the user is editing', () => {
    const onChange = vi.fn();
    render(<SpecEditor label="boolean specification" value="out = a AND b" onChange={onChange} />);

    fireEvent.keyDown(editorContent(), { key: 'Tab' });

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toMatch(/^\s+out = a AND b/);
  });

  it('lets Tab move focus once Escape has been pressed', () => {
    const onChange = vi.fn();
    render(<SpecEditor label="boolean specification" value="out = a AND b" onChange={onChange} />);
    const content = editorContent();

    fireEvent.keyDown(content, { key: 'Escape' });
    const tab = fireEvent.keyDown(content, { key: 'Tab' });

    // Not consumed: the document is untouched and the event was left to the browser,
    // which is what moves focus to the next control.
    expect(onChange).not.toHaveBeenCalled();
    expect(tab).toBe(true);
  });

  it('goes back to indenting after any other key', () => {
    const onChange = vi.fn();
    render(<SpecEditor label="boolean specification" value="out = a AND b" onChange={onChange} />);
    const content = editorContent();

    fireEvent.keyDown(content, { key: 'Escape' });
    fireEvent.keyDown(content, { key: 'a' });
    fireEvent.keyDown(content, { key: 'Tab' });

    expect(onChange).toHaveBeenCalled();
  });
});
