export type RunVerdict = 'Pass' | 'Fail' | 'Inconclusive' | 'ToolFailure';
export type RuleOutcome = 'passed' | 'failed' | 'inapplicable' | 'cantTell' | 'untested';
export type Authority = 'standard' | 'cff-policy';
export type FindingLevel = 'blocking' | 'advisory';
export type Certainty = 'exact' | 'contextual' | 'heuristic';
export type PageKind =
  | 'overview'
  | 'documentation'
  | 'playground'
  | 'results'
  | 'catalogue'
  | 'evidence'
  | 'governance'
  | 'changelog'
  | 'status';

export interface Digest {
  readonly algorithm: 'sha-256';
  readonly value: string;
}

export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface StandardsMapping {
  readonly authority: string;
  readonly reference: string;
  readonly automationLimit: string;
}

export interface SuppressionState {
  readonly suppressed: boolean;
  readonly owner?: string;
  readonly reason?: string;
  readonly expires?: string;
}

export interface Finding {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly authority: Authority;
  readonly level: FindingLevel;
  readonly certainty: Certainty;
  readonly outcome: 'failed' | 'cantTell';
  readonly path: string;
  readonly range: SourceRange;
  readonly message: string;
  readonly observed: string;
  readonly expected: string;
  readonly remediation: string;
  readonly standards: readonly StandardsMapping[];
  readonly evidenceDigest: Digest;
  readonly suppression?: SuppressionState;
}

export interface RuleEvaluation {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly path: string;
  readonly outcome: RuleOutcome;
  readonly level: FindingLevel;
  readonly findingCount: number;
}

export interface ResultCounts {
  readonly blocking: number;
  readonly advisory: number;
  readonly inconclusive: number;
}

export interface ResourceLimit {
  readonly id: string;
  readonly limit: number;
  readonly observed: number;
  readonly path?: string;
}

export interface CffReceipt {
  readonly schemaVersion: 'cff.assay.receipt.v1';
  readonly subject: { readonly root: '.'; readonly digest: Digest };
  readonly assay: { readonly id: 'html5assay'; readonly version: '0.1.0' };
  readonly ruleset: {
    readonly id: 'html5assay-core';
    readonly version: '1.0.0';
    readonly digest: Digest;
  };
  readonly policy: { readonly id: string; readonly version: string; readonly digest: Digest };
  readonly manifestDigest: Digest | null;
  readonly toolchain: {
    readonly node: string;
    readonly htmlParser: 'parse5/7.2.1';
    readonly cssParser: 'postcss/8.5.26';
  };
  readonly verdict: RunVerdict;
  readonly resultDigest: Digest;
  readonly findingsDigest: Digest;
  readonly limits: readonly ResourceLimit[];
  readonly authorityLimitations: readonly string[];
  readonly toolFailures: readonly { readonly code: string; readonly evidenceDigest: Digest }[];
  readonly humanApprovalRequired: true;
}

export interface AnalyzeResult {
  readonly schemaVersion: 'cff.assay.result.v1';
  readonly assay: { readonly id: 'html5assay'; readonly version: '0.1.0' };
  readonly subject: { readonly root: '.'; readonly digest: Digest };
  readonly policy: { readonly id: string; readonly version: string; readonly digest: Digest };
  readonly ruleset: {
    readonly id: 'html5assay-core';
    readonly version: '1.0.0';
    readonly digest: Digest;
  };
  readonly verdict: RunVerdict;
  readonly counts: ResultCounts;
  readonly findings: readonly Finding[];
  readonly evaluations: readonly RuleEvaluation[];
  readonly limits: readonly ResourceLimit[];
  readonly toolFailures: readonly { readonly code: string; readonly evidenceDigest: Digest }[];
  readonly receipt: CffReceipt;
}

export interface PolicyReference {
  readonly id: string;
  readonly path?: string;
}

export interface AnalyzeRequest {
  readonly root: string;
  readonly entries: readonly string[];
  readonly manifest?: string;
  readonly policy: PolicyReference;
}

export interface RuleExample {
  readonly outcome: RuleOutcome;
  readonly html: string;
  readonly note: string;
  readonly context?: {
    readonly pageKind?: PageKind;
    readonly fragment?: {
      readonly contextElement: string;
      readonly contextNamespace?: 'html' | 'svg' | 'mathml';
    };
    readonly assets?: Readonly<Record<string, string>>;
    readonly assetSizes?: Readonly<Record<string, number>>;
  };
}

export interface RuleDefinition {
  readonly id: string;
  readonly version: '1.0.0';
  readonly title: string;
  readonly family: string;
  readonly authority: Authority;
  readonly defaultLevel: FindingLevel;
  readonly applicability: string;
  readonly expectations: readonly string[];
  readonly assumptions: readonly string[];
  readonly standards: readonly StandardsMapping[];
  readonly examples: readonly RuleExample[];
}

export interface SuppressionRecord {
  readonly ruleId: string;
  readonly path?: string;
  readonly owner: string;
  readonly reason: string;
  readonly expires: string;
}

export interface PageManifest {
  readonly schemaVersion: 'cff.page-manifest.v1';
  readonly root?: string;
  readonly entries?: readonly string[];
  readonly pages: Readonly<Record<string, PageKind>>;
  readonly fragments?: Readonly<
    Record<
      string,
      {
        readonly contextElement: string;
        readonly contextNamespace?: 'html' | 'svg' | 'mathml';
      }
    >
  >;
  readonly localAssetRoots?: readonly string[];
  readonly generatedExclusions?: readonly string[];
  readonly requiredShellVersion?: string;
  readonly requiredTheme: 'cff-evidence/1.0.0';
  readonly html5AssayPolicy?: string;
  readonly typescriptAssayProfile?: string;
  readonly steAssayPolicy?: string;
  readonly deploymentHeaders?: string;
  readonly approvedSuppressions?: readonly SuppressionRecord[];
}

export interface PolicyPack {
  readonly schemaVersion: 'cff.html5assay.policy.v1';
  readonly id: string;
  readonly version: string;
  readonly profile: 'strict' | 'balanced';
  readonly reviewDate: string;
  readonly levels: Readonly<Record<string, FindingLevel | 'off'>>;
  readonly limits: {
    readonly inputFiles: number;
    readonly bytesPerTextFile: number;
    readonly totalAnalyzedBytes: number;
    readonly htmlNodesPerDocument: number;
    readonly cssRulesPerGraph: number;
    readonly localReferenceDepth: number;
    readonly findings: number;
  };
  readonly pageBudgets: { readonly default: number; readonly playground: number };
  readonly allowedFormActions: readonly string[];
  readonly suppressions: readonly SuppressionRecord[];
  readonly signature?: {
    readonly algorithm: string;
    readonly keyId: string;
    readonly value: string;
  };
}
