/**
 * The API's response shapes, transcribed by hand.
 *
 * The compiler package could be imported for these, but importing it would pull the whole
 * compiler into the browser bundle for the sake of type aliases that vanish at build time.
 * What is here is what the API actually returns — the view objects in
 * `functions/api/src/routes/*.ts`, not the core's internal types, which are wider.
 */

export type SpecKind = 'boolean' | 'truthtable' | 'python';
export type Role = 'owner' | 'admin' | 'developer' | 'viewer';
export type CheckStatus = 'passed' | 'failed' | 'skipped';

export type CheckId =
  | 'type_shape'
  | 'simulation_equivalence'
  | 'reversibility'
  | 'garbage_free'
  | 'property'
  | 'resource';

export interface Coverage {
  readonly mode: 'exhaustive' | 'sampled';
  readonly checked: number;
  readonly space: number;
  readonly dontCare: number;
}

export interface Counterexample {
  readonly inputs: Record<string, number>;
  readonly expected: Record<string, number>;
  readonly observed: Record<string, number>;
}

export interface CheckResult {
  readonly id: CheckId;
  readonly title: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly durationMs: number;
  readonly coverage?: Coverage;
  readonly counterexample?: Counterexample;
  readonly evidence?: Record<string, unknown>;
}

export interface PassOutcome {
  readonly pass: string;
  readonly outcome: 'applied' | 'no_change' | 'discarded';
  readonly before: number;
  readonly after: number;
  readonly reason?: string;
}

export interface OptimizationSummary {
  readonly passes: readonly PassOutcome[];
  readonly gatesBefore: number;
  readonly gatesAfter: number;
  readonly discarded: number;
}

export interface VerificationView {
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  readonly checksReached: readonly CheckId[];
  readonly stoppedAt: CheckId | null;
  readonly durationMs?: number;
  readonly compilerVersion?: string;
  readonly specHash?: string;
  readonly optimization: OptimizationSummary | null;
  readonly method?: 'exhaustive' | 'sampled';
  readonly sampleCount?: number | null;
  readonly seed?: number;
}

export interface Resources {
  readonly measured: {
    readonly qubits: number | null;
    readonly inputQubits?: number;
    readonly ancillaQubits: number | null;
    readonly outputQubits?: number;
    readonly gateCount: number | null;
    readonly gatesByKind?: Record<string, number>;
    readonly multiQubitGates?: number;
    readonly depth: number | null;
  };
  readonly cliffordT: {
    readonly source: 'measured' | 'projected';
    readonly gateCount: number | null;
    readonly tCount: number | null;
    readonly tDepth: number | null;
    readonly twoQubitGates: number | null;
  };
}

export interface StageRecord {
  readonly stage: string;
  readonly status: string;
  readonly durationMs: number;
  readonly errorCode?: string | null;
}

export interface ArtifactRef {
  readonly id: string;
  readonly kind: 'qasm3' | 'reversible_ir' | 'quantum_ir' | 'trace';
  readonly contentHash: string;
  readonly sizeBytes: number;
}

export interface JobSummary {
  readonly id: string;
  readonly projectId: string;
  readonly specId: string;
  readonly specHash: string;
  readonly status: 'succeeded' | 'failed' | 'rejected' | 'running';
  readonly compilerVersion: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly passed?: boolean | null;
}

export interface SpecView {
  readonly id: string;
  readonly name: string;
  readonly kind: SpecKind;
  readonly source: string;
  readonly budgets: Record<string, number>;
}

export interface CompileResponse {
  readonly job: JobSummary;
  readonly stages: readonly StageRecord[];
  readonly verification: VerificationView;
  readonly resources: Resources;
  readonly artifacts: readonly ArtifactRef[];
  readonly version: { id: string; number: number };
  readonly specHash: string;
  readonly artifactHash: string;
  readonly gateList: string;
  readonly qasm?: string;
}

export interface CompileDetail {
  readonly job: JobSummary;
  readonly spec: SpecView | null;
  readonly stages: readonly StageRecord[];
  readonly verification: VerificationView | null;
  readonly resources: Resources | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly version: { id: string; number: number } | null;
}

export interface Preflight {
  readonly accepted: boolean;
  readonly nodes: number;
  readonly inputs: number;
  readonly projectedGates: number;
  readonly projectedVerificationOps: number;
  readonly limit: number;
  readonly reason?: string;
}

export interface EstimateResponse {
  readonly specHash: string;
  readonly preflight: Preflight;
  readonly resources: Resources;
  readonly stages: readonly StageRecord[];
  readonly optimization: OptimizationSummary | null;
  readonly durationMs: number;
  readonly verified: false;
}

export interface ReverifyResponse {
  readonly jobId: string;
  readonly reproduced: boolean;
  readonly storedPassed: boolean;
  readonly storedCompilerVersion: string;
  readonly compilerVersion: string;
  readonly divergence: readonly {
    readonly id: CheckId;
    readonly storedStatus: CheckStatus | null;
    readonly currentStatus: CheckStatus;
    readonly summary: string;
  }[];
  readonly verification: VerificationView;
}

export interface ArtifactExport {
  readonly artifact: { id: string; kind: string; contentHash: string; sizeBytes: number; createdAt: string };
  readonly verifiedBy: { jobId: string; specHash: string };
  readonly content: string;
}

// --- the reversible IR artifact, which the diagram reads --------------------------

export interface Span {
  readonly line: number;
  readonly column: number;
  readonly length?: number;
}

export type ReversibleGateKind = 'x' | 'cnot' | 'ccnot' | 'cswap';

/** Controls first, target last — `x: [t]`, `cnot: [c, t]`, `ccnot: [c, c, t]`. */
export interface ReversibleGate {
  readonly kind: ReversibleGateKind;
  readonly wires: readonly number[];
  readonly span?: Span;
  readonly nodeId?: number;
}

export interface Wire {
  readonly index: number;
  readonly role: 'input' | 'ancilla' | 'output';
  readonly name: string;
}

/** One ancilla's whole life. A null `uncomputedAtGate` is garbage, and is shown as such. */
export interface AncillaRecord {
  readonly wire: number;
  readonly purpose: string;
  readonly nodeId?: number;
  readonly allocatedAtGate: number;
  readonly uncomputedAtGate: number | null;
  readonly releasedAtGate: number | null;
  readonly span?: Span;
}

export interface ReversibleCircuit {
  readonly name: string;
  readonly wires: readonly Wire[];
  readonly gates: readonly ReversibleGate[];
  readonly inputs: readonly { name: string; wire: number }[];
  readonly outputs: readonly { name: string; wire: number }[];
  readonly ancillas: readonly AncillaRecord[];
}

export interface TraceEntry {
  readonly seq: number;
  readonly phase: string;
  readonly kind: string;
  readonly message: string;
  readonly span?: Span;
  readonly nodeId?: number;
  readonly wires?: readonly number[];
  readonly gateIndex?: number;
  readonly detail?: Record<string, unknown>;
}

// --- identity ---------------------------------------------------------------------

export interface SessionResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: { id: string; email: string; name: string };
  readonly organization?: { id: string; name: string; slug: string; role: Role };
  readonly organizations?: readonly { id: string; name: string; slug: string; role: Role }[];
}

export interface Principal {
  readonly principal: 'session' | 'api_key';
  readonly user?: { id: string; email: string; name: string };
  readonly activeOrganization?: { id: string; role: Role };
  readonly permissions?: readonly string[];
  readonly organizations?: readonly { id: string; name: string; slug: string; role: Role }[];
  readonly organizationId?: string;
  readonly scopes?: readonly string[];
}

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly plan: string;
  readonly dataRegion: string;
  readonly createdAt: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
}

export interface Member {
  readonly userId: string;
  readonly role: Role;
  readonly email: string;
  readonly name: string;
  readonly joinedAt: string;
}

export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revoked: boolean;
}

export interface ApiKeyCreated {
  readonly apiKey: ApiKey;
  readonly secret: string;
  readonly notice: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly actor: { kind: 'user'; id: string; name: string; email: string } | { kind: 'api_key'; id: string } | { kind: 'system' };
  readonly resource: { type: string; id: string | null };
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  readonly nextBefore: string | null;
}

export interface ResourceBudget {
  readonly maxQubits?: number;
  readonly maxDepth?: number;
  readonly maxGates?: number;
  readonly maxTCount?: number;
  readonly maxTDepth?: number;
  readonly maxTwoQubitGates?: number;
}
