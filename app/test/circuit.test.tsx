/**
 * The diagram's text equivalent and its focus behaviour.
 *
 * FR-9.5 asks for a text-equivalent gate list. The test that matters is not "a list
 * exists" but "the list says the same thing as the picture" — so it asserts on the gate
 * labels themselves: kind, controls, target, and source line, for every gate in the
 * circuit, in order.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CircuitDiagram, gateLabel } from '../src/components/CircuitDiagram';
import { circuit } from './fixtures';

describe('the gate label', () => {
  const names = ['a', 'b', 'anc0', 'out'];

  it('names the kind, the controls, the target and the line', () => {
    expect(gateLabel(circuit.gates[0]!, 0, names)).toBe(
      'Gate 1: Toffoli, controls a and b, target anc0, from line 1',
    );
  });

  it('describes a Fredkin as a swap, not as a target', () => {
    // Fredkin is the one gate whose last two wires are both targets; describing it with a
    // single "target" would be wrong in the text while the picture showed two crosses.
    expect(gateLabel({ kind: 'cswap', wires: [0, 1, 2] }, 4, names)).toBe(
      'Gate 5: Fredkin, controls a, swapping b and anc0',
    );
  });
});

describe('the circuit diagram', () => {
  it('exposes every gate as a focusable, named element', () => {
    render(<CircuitDiagram circuit={circuit} selected={null} onSelect={() => {}} />);
    const gates = screen.getAllByRole('button');
    expect(gates).toHaveLength(circuit.gates.length);
    for (const gate of gates) expect(gate.getAttribute('tabindex')).toBe('0');
  });

  it('renders a text list that matches the drawing gate for gate', () => {
    render(<CircuitDiagram circuit={circuit} selected={null} onSelect={() => {}} />);
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    const names = ['a', 'b', 'anc0', 'out'];
    expect(items.map((item) => item.textContent)).toEqual(
      circuit.gates.map((gate, index) => gateLabel(gate, index, names)),
    );
  });

  it('reports the gate under the pointer and clears it on leave', () => {
    const onSelect = vi.fn();
    render(<CircuitDiagram circuit={circuit} selected={null} onSelect={onSelect} />);
    const gate = screen.getAllByRole('button')[1]!;
    fireEvent.mouseEnter(gate);
    expect(onSelect).toHaveBeenLastCalledWith(1);
    fireEvent.mouseLeave(gate);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('reports the gate on keyboard focus, so the link works without a pointer', () => {
    const onSelect = vi.fn();
    render(<CircuitDiagram circuit={circuit} selected={null} onSelect={onSelect} />);
    fireEvent.focus(screen.getAllByRole('button')[2]!);
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });

  it('marks the selected gate as pressed rather than by colour alone', () => {
    render(<CircuitDiagram circuit={circuit} selected={0} onSelect={() => {}} />);
    expect(screen.getAllByRole('button')[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('button')[1]!.getAttribute('aria-pressed')).toBe('false');
  });
});
