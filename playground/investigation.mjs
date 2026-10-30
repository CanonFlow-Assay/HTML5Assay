import { runPreview } from './preview.mjs';

const snapshot = (source, policy) => JSON.stringify({ source, policy });
export function reviewHTML(source, policy = 'cff-web-strict') {
  if (typeof source !== 'string' || !['cff-web-strict', 'cff-web-balanced'].includes(policy))
    throw new TypeError('A local HTML string and supported policy identifier are required.');
  const findings = runPreview(source);
  const first = findings[0];
  return {
    schema: 'html5assay-preview-review/0.1',
    authority: 'non-authoritative-source-preview',
    snapshot: snapshot(source, policy),
    policy,
    verdict: findings.length === 0 ? 'Inconclusive' : 'Fail',
    findings,
    untestedRuleCount: 48,
    next:
      source.trim() === ''
        ? {
            kind: 'ContextRequired',
            reason: 'Supply the HTML document and its local asset scope before investigating.'
          }
        : first
          ? { kind: 'ReviewFinding', ruleId: first.ruleId, reason: first.expected }
          : {
              kind: 'FullAssayRequired',
              reason:
                'Run the full parser-based assay over the declared HTML, CSS, assets and manifest. Forty-eight rules are untested by this preview.'
            }
  };
}
export function selectHTMLInvestigation(review, source, policy, remainingBudget) {
  if (review.snapshot !== snapshot(source, policy))
    return {
      kind: 'ContextRequired',
      reason: 'The source or policy changed. Run a fresh preview.'
    };
  if (!Number.isSafeInteger(remainingBudget) || remainingBudget < 1)
    return {
      kind: 'ContextRequired',
      reason: 'No valid investigation budget remains. Request local review.'
    };
  return review.next;
}
