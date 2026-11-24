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

const readOwnString = (bag, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(bag, key);
    if (!descriptor) return { kind: 'absent' };
    if (!('value' in descriptor) || typeof descriptor.value !== 'string') return { kind: 'invalid' };
    return { kind: 'present', value: descriptor.value };
  } catch {
    return { kind: 'invalid' };
  }
};

export function validatePreviewManifest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze({
      kind: 'ManifestRejected',
      issues: Object.freeze([Object.freeze({ code: 'invalid-manifest', field: 'root' })])
    });
  }
  const issues = [];
  const idField = readOwnString(raw, 'id');
  if (idField.kind === 'absent') {
    issues.push(Object.freeze({ code: 'missing-field', field: 'id' }));
  } else if (idField.kind === 'invalid' || idField.value.trim() === '') {
    issues.push(Object.freeze({ code: 'invalid-field', field: 'id' }));
  }

  const inputField = readOwnString(raw, 'input');
  if (inputField.kind === 'absent') {
    issues.push(Object.freeze({ code: 'missing-field', field: 'input' }));
  } else if (inputField.kind === 'invalid') {
    issues.push(Object.freeze({ code: 'invalid-field', field: 'input' }));
  }

  const policyField = readOwnString(raw, 'policy');
  let policy = 'cff-web-strict';
  if (policyField.kind === 'invalid') {
    issues.push(Object.freeze({ code: 'invalid-policy', field: 'policy' }));
  } else if (policyField.kind === 'present') {
    if (!['cff-web-strict', 'cff-web-balanced'].includes(policyField.value)) {
      issues.push(Object.freeze({ code: 'unsupported-policy', field: 'policy' }));
    } else {
      policy = policyField.value;
    }
  }

  if (issues.length > 0) {
    return Object.freeze({
      kind: 'ManifestRejected',
      issues: Object.freeze(issues)
    });
  }
  return Object.freeze({
    kind: 'ManifestAccepted',
    value: Object.freeze({
      id: idField.value.trim(),
      input: inputField.value,
      policy
    })
  });
}

export function reviewPreviewManifest(raw) {
  const validated = validatePreviewManifest(raw);
  if (validated.kind === 'ManifestRejected') {
    const summary = validated.issues.map((i) => `${i.code}:${i.field}`).join(';');
    return Object.freeze({
      schema: 'html5assay-preview-review/0.1',
      authority: 'non-authoritative-source-preview',
      verdict: 'Inconclusive',
      issues: validated.issues,
      next: Object.freeze({
        kind: 'ContextRequired',
        reason: `Preview manifest validation failed (${summary}). Supply a valid local specimen envelope.`
      })
    });
  }
  return reviewHTML(validated.value.input, validated.value.policy);
}
