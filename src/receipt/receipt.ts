import type { CffReceipt, Digest, Finding, ResourceLimit, RunVerdict } from '../api/model.js';
import { canonicalDigest } from '../result/canonical.js';
import { rulesetIdentity } from '../rules/catalog.js';

interface ReceiptInput {
  readonly subject: Digest;
  readonly policy: { readonly id: string; readonly version: string; readonly digest: Digest };
  readonly manifestDigest: Digest | null;
  readonly verdict: RunVerdict;
  readonly findings: readonly Finding[];
  readonly limits: readonly ResourceLimit[];
  readonly resultDigest: Digest;
  readonly authorityLimitations: readonly string[];
  readonly toolFailures: readonly { readonly code: string; readonly evidenceDigest: Digest }[];
}

export const createReceipt = (input: ReceiptInput): CffReceipt => ({
  schemaVersion: 'cff.assay.receipt.v1',
  subject: { root: '.', digest: input.subject },
  assay: { id: 'html5assay', version: '0.1.0' },
  ruleset: rulesetIdentity,
  policy: input.policy,
  manifestDigest: input.manifestDigest,
  toolchain: {
    node: process.versions.node,
    htmlParser: 'parse5/7.2.1',
    cssParser: 'postcss/8.5.6'
  },
  verdict: input.verdict,
  resultDigest: input.resultDigest,
  findingsDigest: canonicalDigest(input.findings),
  limits: input.limits,
  authorityLimitations: input.authorityLimitations,
  toolFailures: input.toolFailures,
  humanApprovalRequired: true
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const validDigest = (value: unknown): boolean =>
  isRecord(value) &&
  value.algorithm === 'sha-256' &&
  typeof value.value === 'string' &&
  /^[0-9a-f]{64}$/u.test(value.value);

export const verifyReceipt = (
  value: unknown
): {
  readonly valid: boolean;
  readonly reasons: readonly string[];
  readonly verified: readonly string[];
  readonly unverifiedBindings: readonly string[];
} => {
  const reasons: string[] = [];
  const unverifiedBindings = [
    'subject bytes',
    'canonical result artifact',
    'finding artifact',
    'policy signature'
  ];
  if (!isRecord(value) || value.schemaVersion !== 'cff.assay.receipt.v1')
    return {
      valid: false,
      reasons: ['Receipt schemaVersion is invalid.'],
      verified: [],
      unverifiedBindings
    };
  const assay = value.assay;
  const ruleset = value.ruleset;
  const subject = value.subject;
  const policy = value.policy;
  const toolchain = value.toolchain;
  if (!isRecord(assay) || assay.id !== 'html5assay' || assay.version !== '0.1.0')
    reasons.push('Assay identity is invalid.');
  if (
    !isRecord(ruleset) ||
    ruleset.id !== rulesetIdentity.id ||
    ruleset.version !== rulesetIdentity.version ||
    !isRecord(ruleset.digest) ||
    ruleset.digest.value !== rulesetIdentity.digest.value
  )
    reasons.push('Ruleset identity or digest does not match this tool.');
  if (!isRecord(subject) || subject.root !== '.' || !validDigest(subject.digest))
    reasons.push('Subject root or digest is invalid.');
  if (
    !isRecord(policy) ||
    typeof policy.id !== 'string' ||
    policy.id.trim() === '' ||
    typeof policy.version !== 'string' ||
    !/^(?:\d+\.\d+\.\d+|unknown)$/u.test(policy.version) ||
    !validDigest(policy.digest)
  )
    reasons.push('Policy identity or digest is invalid.');
  if (value.manifestDigest !== null && !validDigest(value.manifestDigest))
    reasons.push('Manifest digest is invalid.');
  if (
    !isRecord(toolchain) ||
    typeof toolchain.node !== 'string' ||
    !/^\d+\.\d+\.\d+/u.test(toolchain.node) ||
    toolchain.htmlParser !== 'parse5/7.2.1' ||
    toolchain.cssParser !== 'postcss/8.5.6'
  )
    reasons.push('Toolchain identity is invalid.');
  if (!validDigest(value.resultDigest) || !validDigest(value.findingsDigest))
    reasons.push('Result or findings digest is invalid.');
  if (!['Pass', 'Fail', 'Inconclusive', 'ToolFailure'].includes(String(value.verdict)))
    reasons.push('Verdict is invalid.');
  if (
    !Array.isArray(value.limits) ||
    !value.limits.every(
      (limit) =>
        isRecord(limit) &&
        typeof limit.id === 'string' &&
        Number.isSafeInteger(limit.limit) &&
        (limit.limit as number) >= 0 &&
        Number.isSafeInteger(limit.observed) &&
        (limit.observed as number) >= 0 &&
        (limit.path === undefined ||
          (typeof limit.path === 'string' && !isAbsoluteLike(limit.path)))
    )
  )
    reasons.push('Resource limits are invalid or contain a machine path.');
  if (
    !Array.isArray(value.authorityLimitations) ||
    !value.authorityLimitations.every((item) => typeof item === 'string') ||
    value.authorityLimitations.length === 0
  )
    reasons.push('Authority limitations are invalid.');
  if (
    !Array.isArray(value.toolFailures) ||
    !value.toolFailures.every(
      (failure) =>
        isRecord(failure) &&
        typeof failure.code === 'string' &&
        /^H5A-[A-Z0-9-]+$/u.test(failure.code) &&
        validDigest(failure.evidenceDigest)
    )
  )
    reasons.push('Tool-failure evidence is invalid.');
  if (
    value.verdict === 'ToolFailure' &&
    (value.toolFailures as readonly unknown[] | undefined)?.length === 0
  )
    reasons.push('ToolFailure verdict lacks tool-failure evidence.');
  if (
    value.verdict !== 'ToolFailure' &&
    (value.toolFailures as readonly unknown[] | undefined)?.length !== 0
  )
    reasons.push('Non-ToolFailure verdict contains tool-failure evidence.');
  if (value.humanApprovalRequired !== true) reasons.push('Human approval requirement is missing.');
  return {
    valid: reasons.length === 0,
    reasons,
    verified:
      reasons.length === 0
        ? [
            'receipt schema',
            'assay identity',
            'current ruleset digest',
            'digest shapes',
            'toolchain identity'
          ]
        : [],
    unverifiedBindings
  };
};

const isAbsoluteLike = (value: string): boolean => /^(?:\/|[a-z]:[\\/])/iu.test(value);
