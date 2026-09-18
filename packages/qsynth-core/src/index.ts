/**
 * Public surface of the compiler. The API Lambda and the test suites import from here
 * only — deep imports into `src/` from outside the package are how internal structure
 * becomes someone else's dependency.
 */
export * from './version.js';
export * from './errors.js';
export * from './hash.js';

export * from './ir/classical.js';
export * from './ir/reversible.js';
export * from './eval/classical.js';
export * from './trace/trace.js';

export * from './frontend/boolean/lexer.js';
export * from './frontend/boolean/parser.js';
export * from './frontend/boolean/lower.js';
export * from './frontend/truthtable/parser.js';
export * from './frontend/truthtable/lower.js';
export * from './frontend/python/lexer.js';
export * from './frontend/python/parser.js';
export * from './frontend/python/lower.js';

// Re-exported by name rather than with `*`: the quantum IR has its own `depth`,
// `gateCount` and `gatesByKind`, and a star export would silently drop whichever lost
// the collision with the reversible IR's.
export {
  QUANTUM_ARITY,
  NON_CLIFFORD,
  QuantumBuilder,
  ADJOINT,
  adjoint,
  isClifford,
  tCount,
  tDepth,
  twoQubitCount,
  gateCount as quantumGateCount,
  gatesByKind as quantumGatesByKind,
  depth as quantumDepth,
  type QuantumGateKind,
  type QuantumGate,
  type QuantumCircuit,
} from './ir/quantum.js';

export * from './lowering/classicalToReversible.js';
export * from './lowering/reversibleToQuantum.js';
export * from './sim/basisState.js';
export * from './sim/statevector.js';
export * from './sim/stabilizer.js';
export * from './verify/decomposition.js';
export * from './estimate/resources.js';
export * from './emit/qasm3.js';
export * from './verify/report.js';
export * from './verify/plan.js';
export * from './verify/checks.js';

export * from './passes/types.js';
export * from './passes/rewrite.js';
export * from './passes/cancelInverses.js';
export * from './passes/constantFold.js';
export * from './passes/reuseValues.js';
export * from './passes/dropUnusedAncillas.js';
export * from './passes/runner.js';
export * from './util/rng.js';
export * from './compile.js';
