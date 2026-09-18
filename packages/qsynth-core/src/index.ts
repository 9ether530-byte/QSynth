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

export * from './lowering/classicalToReversible.js';
export * from './sim/basisState.js';
export * from './estimate/resources.js';
export * from './emit/qasm3.js';
export * from './verify/report.js';
export * from './verify/checks.js';
export * from './util/rng.js';
export * from './compile.js';
