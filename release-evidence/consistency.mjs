const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export const releaseEvidenceConsistencyIssues = (record) => {
  const issues = [];
  const candidate = record?.candidate ?? {};
  const candidateEmpty = candidate.gitCommit === null && candidate.archiveSha256 === null;
  const candidateComplete =
    typeof candidate.gitCommit === 'string' && typeof candidate.archiveSha256 === 'string';
  if (!candidateEmpty && !candidateComplete)
    issues.push('candidate gitCommit and archiveSha256 must both be null or both be set');

  for (const item of Array.isArray(record?.items) ? record.items : []) {
    const scope = typeof item.id === 'string' ? item.id : '(unknown gate)';
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    const reviewer = item.reviewer ?? {};
    const candidateBound = evidence.filter((entry) => entry.candidateBound === true);
    const expectedDecision =
      item.status === 'accepted' ? 'accepted' : item.status === 'rejected' ? 'rejected' : 'pending';

    if (reviewer.decision !== expectedDecision)
      issues.push(`${scope}: ${String(item.status)} status requires ${expectedDecision} review`);

    if (expectedDecision === 'pending') {
      if (reviewer.identity !== null || reviewer.reviewedAt !== null)
        issues.push(`${scope}: pending review requires null identity and reviewedAt`);
    } else {
      if (typeof reviewer.identity !== 'string' || reviewer.identity.length === 0)
        issues.push(`${scope}: completed review requires a reviewer identity`);
      if (
        typeof reviewer.reviewedAt !== 'string' ||
        !timestamp.test(reviewer.reviewedAt) ||
        Number.isNaN(Date.parse(reviewer.reviewedAt))
      )
        issues.push(`${scope}: completed review requires a valid UTC reviewedAt timestamp`);
    }

    if (item.status === 'pending' && evidence.some((entry) => entry.state === 'invalidated'))
      issues.push(`${scope}: pending evidence cannot be marked invalidated`);

    if (
      ['provisional', 'accepted', 'rejected'].includes(item.status) &&
      evidence.some((entry) => entry.state !== 'available')
    )
      issues.push(`${scope}: ${String(item.status)} status requires all evidence to be available`);

    if (item.status === 'invalidated') {
      if (candidateBound.length === 0)
        issues.push(`${scope}: invalidated status requires candidate-bound evidence`);
      if (candidateBound.some((entry) => entry.state !== 'invalidated'))
        issues.push(
          `${scope}: invalidated status requires candidate-bound evidence to be invalidated`
        );
      if (evidence.some((entry) => entry.candidateBound !== true && entry.state !== 'available'))
        issues.push(
          `${scope}: non-candidate evidence must remain available when a gate is invalidated`
        );
    }

    if (candidateBound.length > 0 && item.status !== 'pending' && !candidateComplete)
      issues.push(
        `${scope}: ${String(item.status)} candidate-bound evidence requires candidate identity`
      );
  }

  return issues;
};
