import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

interface ActionReview {
  readonly actions: ReadonlyArray<{
    readonly repository: string;
    readonly commit: string;
  }>;
}

interface ReleaseRecord {
  readonly candidate: { readonly gitCommit: string | null; readonly archiveSha256: string | null };
  readonly invalidationPolicy: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly evidence: ReadonlyArray<{
      readonly locator: string;
      readonly candidateBound: boolean;
      readonly state: 'available' | 'pending' | 'invalidated';
    }>;
    readonly reviewer: {
      readonly requiredRole: string;
      readonly identity: string | null;
      readonly decision: 'pending' | 'accepted' | 'rejected';
      readonly reviewedAt: string | null;
    };
  }>;
}

const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

void test('release evidence maps every stable checklist gate to evidence and a reviewer', async () => {
  const { releaseEvidenceConsistencyIssues } = (await import(
    pathToFileURL(resolve('release-evidence/consistency.mjs')).href
  )) as {
    readonly releaseEvidenceConsistencyIssues: (record: unknown) => ReadonlyArray<string>;
  };
  const checklist = await readFile('docs/release-checklist.md', 'utf8');
  const checklistIds = [...checklist.matchAll(/\*\*(RG-[0-9]{2})\*\*/gu)].map((match) => match[1]);
  const record = await json<ReleaseRecord>('release-evidence/0.1.0.json');
  const recordIds = record.items.map((item) => item.id);
  assert.equal(new Set(checklistIds).size, checklistIds.length);
  assert.equal(new Set(recordIds).size, recordIds.length);
  assert.deepEqual([...recordIds].sort(), [...checklistIds].sort());
  assert.match(record.invalidationPolicy, /commit or archive digest change invalidates/iu);
  for (const item of record.items) {
    assert.ok(item.evidence.length > 0, `${item.id} is missing evidence mapping`);
    assert.ok(item.evidence.every((entry) => entry.locator.length > 0));
    assert.ok(item.reviewer.requiredRole.length > 0, `${item.id} is missing a reviewer role`);
  }
  if (record.candidate.gitCommit === null || record.candidate.archiveSha256 === null) {
    assert.equal(
      record.items.some((item) => item.status === 'accepted'),
      false
    );
    assert.equal(
      record.items.some((item) => item.reviewer.decision === 'accepted'),
      false
    );
  }
  assert.deepEqual(releaseEvidenceConsistencyIssues(record), []);

  const gate = record.items.at(0);
  assert.ok(gate !== undefined);
  const candidate = { gitCommit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64) };
  const availableEvidence = gate.evidence.map((entry) => ({
    ...entry,
    state: 'available' as const
  }));
  const invalidAccepted = {
    ...record,
    candidate,
    items: [
      {
        ...gate,
        status: 'accepted',
        evidence: availableEvidence,
        reviewer: { ...gate.reviewer, decision: 'accepted', identity: null, reviewedAt: null }
      },
      ...record.items.slice(1)
    ]
  };
  const acceptedIssues = releaseEvidenceConsistencyIssues(invalidAccepted).join('; ');
  assert.match(acceptedIssues, /reviewer identity/iu);
  assert.match(acceptedIssues, /reviewedAt timestamp/iu);

  const invalidRejected = {
    ...record,
    candidate,
    items: [
      {
        ...gate,
        status: 'rejected',
        evidence: availableEvidence,
        reviewer: {
          ...gate.reviewer,
          decision: 'accepted',
          identity: 'reviewer@example.test',
          reviewedAt: '2026-08-19T18:00:00.000Z'
        }
      },
      ...record.items.slice(1)
    ]
  };
  assert.match(
    releaseEvidenceConsistencyIssues(invalidRejected).join('; '),
    /requires rejected review/iu
  );

  const invalidInvalidated = {
    ...record,
    candidate,
    items: [
      { ...gate, status: 'invalidated', evidence: availableEvidence },
      ...record.items.slice(1)
    ]
  };
  assert.match(
    releaseEvidenceConsistencyIssues(invalidInvalidated).join('; '),
    /candidate-bound evidence to be invalidated/iu
  );

  const partialCandidate = {
    ...record,
    candidate: { gitCommit: 'a'.repeat(40), archiveSha256: null }
  };
  assert.match(
    releaseEvidenceConsistencyIssues(partialCandidate).join('; '),
    /must both be null or both be set/iu
  );
});

void test('every GitHub Action is pinned to its reviewed full commit SHA', async () => {
  const review = await json<ActionReview>('release-evidence/workflow-actions.json');
  const reviewed = new Map(review.actions.map((action) => [action.repository, action.commit]));
  const workflowNames = (await readdir('.github/workflows')).filter(
    (name) => name.endsWith('.yml') || name.endsWith('.yaml')
  );
  const seen = new Set<string>();
  for (const name of workflowNames) {
    const workflow = await readFile(`.github/workflows/${name}`, 'utf8');
    for (const match of workflow.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/gmu)) {
      const repository = match[1];
      const commit = match[2];
      assert.ok(repository !== undefined && commit !== undefined);
      assert.match(commit, /^[0-9a-f]{40}$/u, `${name}: mutable action ${repository}@${commit}`);
      assert.equal(commit, reviewed.get(repository), `${name}: unreviewed action ${repository}`);
      seen.add(repository);
    }
  }
  assert.deepEqual([...seen].sort(), [...reviewed.keys()].sort());
});

void test('browser workflow uses the reviewed immutable container with host networking denied', async () => {
  const environment = await json<{
    readonly container: { readonly reference: string; readonly networkMode: string };
  }>('browser-harness/environment-lock.json');
  const workflow = await readFile('.github/workflows/browser-qualification.yml', 'utf8');
  assert.ok(workflow.includes(`BROWSER_IMAGE: ${environment.container.reference}`));
  assert.equal(environment.container.networkMode, 'none');
  assert.match(workflow, /docker run --rm \\\n+\s+--network none/gu);
  assert.match(workflow, /HTML5ASSAY_HOST_NETWORK_DENIAL=docker-network-none/gu);
  assert.match(workflow, /pnpm pack --pack-destination candidate/gu);
  assert.match(workflow, /sha256sum "\$archive"/gu);
  assert.match(workflow, /CANDIDATE_SHA256: \$\{\{ steps\.candidate\.outputs\.sha256 \}\}/gu);
  assert.match(workflow, /candidate\/\*\.tgz/gu);
});
