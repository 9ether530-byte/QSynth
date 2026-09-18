/**
 * The circuit diagram, drawn as SVG.
 *
 * SVG rather than canvas, and the reason is accessibility before rendering. Each gate is a
 * real DOM node, so it can be focused, named, and linked in both directions — hover a gate
 * and the trace entry and the source line that produced it light up; hover a trace entry
 * and the gate does. A canvas would need a parallel hit-test structure, a parallel focus
 * model, and a parallel text equivalent, all of which could drift from the drawing.
 *
 * The text-equivalent gate list (FR-9.5) is rendered from exactly the same array as the
 * picture. That is the point: not a second description that has to be kept in step, but
 * the same data in the other modality.
 */
import { useMemo } from 'react';
import type { ReversibleCircuit, ReversibleGate } from '../lib/types';

const COLUMN = 30;
const ROW = 24;
const LEFT = 148;
const TOP = 20;

const GATE_NAMES: Record<string, string> = {
  x: 'NOT',
  cnot: 'CNOT',
  ccnot: 'Toffoli',
  cswap: 'Fredkin',
};

/** Controls come first and the target last — except Fredkin, which swaps its last two. */
function parts(gate: ReversibleGate): { controls: number[]; targets: number[] } {
  if (gate.kind === 'cswap') {
    const [control, a, b] = gate.wires;
    return { controls: control === undefined ? [] : [control], targets: [a, b].filter((w): w is number => w !== undefined) };
  }
  const wires = [...gate.wires];
  const target = wires.pop();
  return { controls: wires, targets: target === undefined ? [] : [target] };
}

export function gateLabel(gate: ReversibleGate, index: number, names: readonly string[]): string {
  const { controls, targets } = parts(gate);
  const name = (wire: number) => names[wire] ?? `q${wire}`;
  const kind = GATE_NAMES[gate.kind] ?? gate.kind;
  const controlText = controls.length ? `, controls ${controls.map(name).join(' and ')}` : '';
  const targetText =
    gate.kind === 'cswap'
      ? `, swapping ${targets.map(name).join(' and ')}`
      : `, target ${targets.map(name).join(' and ')}`;
  const where = gate.span ? `, from line ${gate.span.line}` : '';
  return `Gate ${index + 1}: ${kind}${controlText}${targetText}${where}`;
}

export function CircuitDiagram({
  circuit,
  selected,
  onSelect,
}: {
  circuit: ReversibleCircuit;
  selected: number | null;
  onSelect: (gateIndex: number | null) => void;
}) {
  const names = useMemo(() => {
    const out: string[] = [];
    for (const wire of circuit.wires) out[wire.index] = wire.name;
    return out;
  }, [circuit]);

  const width = LEFT + Math.max(circuit.gates.length, 1) * COLUMN + 40;
  const height = TOP + circuit.wires.length * ROW + 20;
  const y = (wire: number) => TOP + wire * ROW;
  const x = (gate: number) => LEFT + gate * COLUMN + COLUMN / 2;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`Circuit ${circuit.name}: ${circuit.wires.length} qubits, ${circuit.gates.length} gates. Each gate is focusable; a text list follows the diagram.`}
          className="font-mono"
        >
          {circuit.wires.map((wire) => (
            <g key={wire.index}>
              <text
                x={LEFT - 10}
                y={y(wire.index) + 4}
                textAnchor="end"
                fontSize="11"
                fill={wire.role === 'ancilla' ? 'var(--color-ink-faint)' : 'var(--color-ink-dim)'}
              >
                {wire.name}
              </text>
              <line
                x1={LEFT}
                x2={width - 20}
                y1={y(wire.index)}
                y2={y(wire.index)}
                stroke="var(--color-rule-strong)"
                strokeWidth="1"
                // Ancilla wires are dashed as well as dimmer, so the distinction survives
                // a monochrome rendering.
                strokeDasharray={wire.role === 'ancilla' ? '3 3' : undefined}
              />
            </g>
          ))}

          {circuit.gates.map((gate, index) => {
            const { controls, targets } = parts(gate);
            const wires = [...controls, ...targets];
            const top = Math.min(...wires);
            const bottom = Math.max(...wires);
            const isSelected = selected === index;
            const stroke = isSelected ? 'var(--color-verified)' : 'var(--color-ink-dim)';
            return (
              <g
                key={index}
                role="button"
                tabIndex={0}
                aria-label={gateLabel(gate, index, names)}
                aria-pressed={isSelected}
                className="cursor-pointer outline-offset-2"
                onMouseEnter={() => onSelect(index)}
                onMouseLeave={() => onSelect(null)}
                onFocus={() => onSelect(index)}
                onBlur={() => onSelect(null)}
                onClick={() => onSelect(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(index);
                  }
                }}
              >
                {/* A transparent column so the whole gate is a comfortable hit target. */}
                <rect
                  x={x(index) - COLUMN / 2}
                  y={TOP - ROW / 2}
                  width={COLUMN}
                  height={circuit.wires.length * ROW}
                  fill={isSelected ? 'var(--color-raised)' : 'transparent'}
                />
                <line x1={x(index)} x2={x(index)} y1={y(top)} y2={y(bottom)} stroke={stroke} strokeWidth="1" />
                {controls.map((wire) => (
                  <circle key={`c${wire}`} cx={x(index)} cy={y(wire)} r="3.5" fill={stroke} />
                ))}
                {gate.kind === 'cswap'
                  ? targets.map((wire) => (
                      <g key={`t${wire}`} stroke={stroke} strokeWidth="1.5">
                        <line x1={x(index) - 4} x2={x(index) + 4} y1={y(wire) - 4} y2={y(wire) + 4} />
                        <line x1={x(index) - 4} x2={x(index) + 4} y1={y(wire) + 4} y2={y(wire) - 4} />
                      </g>
                    ))
                  : targets.map((wire) => (
                      <g key={`t${wire}`} stroke={stroke} strokeWidth="1.2" fill="var(--color-ground)">
                        <circle cx={x(index)} cy={y(wire)} r="6" />
                        <line x1={x(index) - 6} x2={x(index) + 6} y1={y(wire)} y2={y(wire)} />
                        <line x1={x(index)} x2={x(index)} y1={y(wire) - 6} y2={y(wire) + 6} />
                      </g>
                    ))}
              </g>
            );
          })}
        </svg>
      </div>

      <details className="border-t border-rule">
        <summary className="qs-label cursor-pointer px-3 py-2">
          Gate list ({circuit.gates.length} gates, text equivalent)
        </summary>
        <ol className="m-0 max-h-56 list-none overflow-auto p-0 font-mono text-xs">
          {circuit.gates.map((gate, index) => (
            <li
              key={index}
              className={`border-b border-rule/50 px-3 py-1 last:border-b-0 ${
                selected === index ? 'bg-raised text-verified' : 'text-ink-dim'
              }`}
              onMouseEnter={() => onSelect(index)}
              onMouseLeave={() => onSelect(null)}
            >
              {gateLabel(gate, index, names)}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
