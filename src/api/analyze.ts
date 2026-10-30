import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AnalyzeRequest, AnalyzeResult, Digest, Finding, ResourceLimit } from './model.js';
import { buildGraph } from '../graph/build.js';
import { GraphBuildFailure } from '../graph/build.js';
import { evaluateRules } from '../rules/evaluate.js';
import { loadManifest, loadPolicy } from '../policy/load.js';
import { canonicalDigest, digest } from '../result/canonical.js';
import { deriveVerdict, resultCounts } from '../result/verdict.js';
import { createReceipt } from '../receipt/receipt.js';
import { rulesetIdentity } from '../rules/catalog.js';

const compareFindings = (left: Finding, right: Finding): number => {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.range.start.offset !== right.range.start.offset)
    return left.range.start.offset - right.range.start.offset;
  if (left.ruleId !== right.ruleId) return left.ruleId < right.ruleId ? -1 : 1;
  return left.evidenceDigest.value < right.evidenceDigest.value
    ? -1
    : left.evidenceDigest.value > right.evidenceDigest.value
      ? 1
      : 0;
};

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

const authorityLimitations = [
  'Static source checks do not prove complete WCAG conformance, runtime behavior, rendering, interaction, or content quality.',
  'No page script is executed and no network resource is fetched.',
  'A Pass applies only to the supplied bytes, manifest, pinned policy, and implemented static expectations.',
  'Human review is required before release, signature, waiver, or promotion.'
] as const;

interface CoreResult {
  readonly schemaVersion: 'cff.assay.result.v1';
  readonly assay: AnalyzeResult['assay'];
  readonly subject: AnalyzeResult['subject'];
  readonly policy: AnalyzeResult['policy'];
  readonly ruleset: AnalyzeResult['ruleset'];
  readonly verdict: AnalyzeResult['verdict'];
  readonly counts: AnalyzeResult['counts'];
  readonly findings: AnalyzeResult['findings'];
  readonly evaluations: AnalyzeResult['evaluations'];
  readonly limits: AnalyzeResult['limits'];
  readonly toolFailures: AnalyzeResult['toolFailures'];
}

const assemble = (
  subjectDigest: Digest,
  policy: AnalyzeResult['policy'],
  manifestDigest: Digest | null,
  core: Omit<CoreResult, 'schemaVersion' | 'assay' | 'subject' | 'policy' | 'ruleset'>
): AnalyzeResult => {
  const base: CoreResult = {
    schemaVersion: 'cff.assay.result.v1',
    assay: { id: 'html5assay', version: '0.1.0' },
    subject: { root: '.', digest: subjectDigest },
    policy,
    ruleset: rulesetIdentity,
    ...core
  };
  return {
    ...base,
    receipt: createReceipt({
      subject: subjectDigest,
      policy,
      manifestDigest,
      verdict: base.verdict,
      findings: base.findings,
      limits: base.limits,
      resultDigest: canonicalDigest(base),
      authorityLimitations,
      toolFailures: base.toolFailures
    })
  };
};

const analyzeProcedure = async (request: AnalyzeRequest): Promise<AnalyzeResult> => {
  const requestRoot = await realpath(request.root);
  const loadedPolicy = await loadPolicy(request.policy, requestRoot);
  const loadedManifest =
    request.manifest === undefined ? null : await loadManifest(request.manifest, requestRoot);
  if (
    loadedManifest?.manifest.html5AssayPolicy !== undefined &&
    loadedManifest.manifest.html5AssayPolicy !== loadedPolicy.pack.id
  ) {
    throw new Error('Manifest HTML5Assay policy does not match the selected policy');
  }
  let analysisRoot = requestRoot;
  if (loadedManifest?.manifest.root !== undefined) {
    const candidate = resolve(requestRoot, loadedManifest.manifest.root);
    if (!inside(requestRoot, candidate)) throw new Error('Manifest root escapes request root');
    analysisRoot = await realpath(candidate);
    if (!inside(requestRoot, analysisRoot))
      throw new Error('Manifest root symlink escapes request root');
  }
  const entries =
    request.entries.length > 0 ? request.entries : (loadedManifest?.manifest.entries ?? []);
  if (entries.length === 0) throw new Error('AnalyzeRequest requires at least one entry');
  const policyIdentity = {
    id: loadedPolicy.pack.id,
    version: loadedPolicy.pack.version,
    digest: loadedPolicy.digest
  };
  try {
    const graph = await buildGraph({
      root: analysisRoot,
      entries,
      manifest: loadedManifest?.manifest ?? null,
      policy: loadedPolicy.pack
    });
    const bundle = evaluateRules(graph, loadedPolicy.pack, loadedManifest?.manifest ?? null);
    const sorted = bundle.findings.slice().sort(compareFindings);
    const limits: ResourceLimit[] = [...graph.limits];
    let findings = sorted;
    const incomplete = [...graph.incompleteReasons];
    if (findings.length > loadedPolicy.pack.limits.findings) {
      limits.push({
        id: 'findings',
        limit: loadedPolicy.pack.limits.findings,
        observed: findings.length
      });
      incomplete.push(`Finding count was truncated from ${findings.length}`);
      findings = findings.slice(0, loadedPolicy.pack.limits.findings);
    }
    const verdict = deriveVerdict(bundle.evaluations, sorted, limits, incomplete);
    return assemble(graph.subjectDigest, policyIdentity, loadedManifest?.digest ?? null, {
      verdict,
      counts: resultCounts(bundle.evaluations, sorted),
      findings,
      evaluations: bundle.evaluations,
      limits,
      toolFailures: []
    });
  } catch (error) {
    const subject = error instanceof GraphBuildFailure ? error.subjectDigest : digest('');
    const code = error instanceof GraphBuildFailure ? error.code : 'H5A-TOOL-SETUP';
    const evidenceDigest = digest(code);
    return assemble(subject, policyIdentity, loadedManifest?.digest ?? null, {
      verdict: 'ToolFailure',
      counts: { blocking: 0, advisory: 0, inconclusive: 0 },
      findings: [],
      evaluations: [],
      limits: [],
      toolFailures: [{ code, evidenceDigest }]
    });
  }
};

export const analyze = async (request: AnalyzeRequest): Promise<AnalyzeResult> => {
  try {
    return await analyzeProcedure(request);
  } catch {
    const policy = {
      id: request.policy.id,
      version: 'unknown',
      digest: canonicalDigest(request.policy)
    };
    return assemble(digest(''), policy, null, {
      verdict: 'ToolFailure',
      counts: { blocking: 0, advisory: 0, inconclusive: 0 },
      findings: [],
      evaluations: [],
      limits: [],
      toolFailures: [{ code: 'H5A-TOOL-SETUP', evidenceDigest: digest('H5A-TOOL-SETUP') }]
    });
  }
};
