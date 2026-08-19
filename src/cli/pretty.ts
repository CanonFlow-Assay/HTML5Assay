import type { AnalyzeResult } from '../api/model.js';

export const prettyResult = (result: AnalyzeResult): string => {
  const lines = [
    `HTML5Assay ${result.assay.version}`,
    `verdict: ${result.verdict}`,
    `policy: ${result.policy.id}/${result.policy.version}`,
    `subject: sha-256:${result.subject.digest.value}`,
    `findings: ${result.counts.blocking} blocking, ${result.counts.advisory} advisory, ${result.counts.inconclusive} inconclusive`
  ];
  for (const finding of result.findings) {
    const suppressed = finding.suppression?.suppressed === true ? ' [suppressed]' : '';
    lines.push(
      `${finding.path}:${finding.range.start.line}:${finding.range.start.column} ${finding.ruleId} ${finding.level}${suppressed} ${finding.message}`
    );
  }
  if (result.limits.length > 0) {
    lines.push('limits:');
    for (const limit of result.limits)
      lines.push(
        `  ${limit.id}: observed ${limit.observed}, limit ${limit.limit}${limit.path === undefined ? '' : ` (${limit.path})`}`
      );
  }
  lines.push('authority: Static source evidence only; human release approval is required.');
  return `${lines.join('\n')}\n`;
};
