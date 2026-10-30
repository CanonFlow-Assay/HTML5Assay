import type { Finding, ResourceLimit, RuleEvaluation, RunVerdict } from '../api/model.js';

const unsuppressed = (finding: Finding): boolean => finding.suppression?.suppressed !== true;

export const deriveVerdict = (
  evaluations: readonly RuleEvaluation[],
  findings: readonly Finding[],
  limits: readonly ResourceLimit[],
  incompleteReasons: readonly string[],
  toolFailure = false
): RunVerdict => {
  if (toolFailure) return 'ToolFailure';
  const blockingFailure = findings.some(
    (finding) =>
      finding.level === 'blocking' && finding.outcome === 'failed' && unsuppressed(finding)
  );
  if (blockingFailure) return 'Fail';
  const unknownRequired = evaluations.some(
    (evaluation) =>
      evaluation.level === 'blocking' &&
      (evaluation.outcome === 'cantTell' || evaluation.outcome === 'untested')
  );
  if (unknownRequired || limits.length > 0 || incompleteReasons.length > 0) return 'Inconclusive';
  return 'Pass';
};

export const resultCounts = (
  evaluations: readonly RuleEvaluation[],
  findings: readonly Finding[]
): { readonly blocking: number; readonly advisory: number; readonly inconclusive: number } => {
  const failedFindings = findings.filter(
    (finding) => unsuppressed(finding) && finding.outcome === 'failed'
  );
  return {
    blocking: failedFindings.filter((finding) => finding.level === 'blocking').length,
    advisory: failedFindings.filter((finding) => finding.level === 'advisory').length,
    inconclusive: evaluations.filter(
      (evaluation) => evaluation.outcome === 'cantTell' || evaluation.outcome === 'untested'
    ).length
  };
};
