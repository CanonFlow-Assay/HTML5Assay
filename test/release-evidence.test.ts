import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

interface ActionReview {
  readonly actions: ReadonlyArray<{
    readonly repository: string;
    readonly commit: string;
    readonly sourceTag: string;
    readonly actionRuntime: string;
    readonly publishedSecurityAdvisories: number;
    readonly githubVerifiedCommit: boolean;
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
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

void test('pre-candidate dependency review remains bound to package and lock inputs', async () => {
  const review = await json<{
    readonly result: string;
    readonly headAcceptance: string;
    readonly candidateGenerated: boolean;
    readonly runtime: { readonly node: string; readonly packageManager: string };
    readonly audit: {
      readonly productionVulnerabilities: number;
      readonly fullVulnerabilities: number;
    };
    readonly lockfile: {
      readonly packageJsonSha256: string;
      readonly pnpmLockSha256: string;
      readonly packageRecords: number;
      readonly sha512IntegrityRecords: number;
      readonly nonRegistryPackageSources: number;
      readonly requiresBuildRecords: number;
    };
  }>('release-evidence/artifacts/0.1.0/pre-candidate-security-review.json');
  const packageSource = await readFile('package.json', 'utf8');
  const lockSource = await readFile('pnpm-lock.yaml', 'utf8');
  const packageValue = JSON.parse(packageSource) as {
    readonly engines: { readonly node: string; readonly npm?: string };
    readonly packageManager: string;
  };
  assert.equal(review.result, 'local-correction-checks-pass');
  assert.equal(review.headAcceptance, 'pending-fresh-ci-and-exact-head-review');
  assert.equal(review.candidateGenerated, false);
  assert.equal(review.runtime.node, packageValue.engines.node);
  assert.equal(review.runtime.packageManager, packageValue.packageManager);
  assert.equal(packageValue.engines.npm, undefined);
  assert.equal(review.audit.productionVulnerabilities, 0);
  assert.equal(review.audit.fullVulnerabilities, 0);
  assert.equal(review.lockfile.packageJsonSha256, sha256(packageSource));
  assert.equal(review.lockfile.pnpmLockSha256, sha256(lockSource));
  assert.equal(review.lockfile.packageRecords, review.lockfile.sha512IntegrityRecords);
  assert.equal(review.lockfile.nonRegistryPackageSources, 0);
  assert.equal(review.lockfile.requiresBuildRecords, 0);
});

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
    const checkoutCount = [...workflow.matchAll(/uses:\s*actions\/checkout@/gu)].length;
    const nonPersistentCheckoutCount = [...workflow.matchAll(/persist-credentials:\s*false/gu)]
      .length;
    assert.equal(
      nonPersistentCheckoutCount,
      checkoutCount,
      `${name}: every checkout must disable persisted credentials`
    );
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
  for (const action of review.actions) {
    assert.equal(action.actionRuntime, 'node24');
    assert.equal(action.publishedSecurityAdvisories, 0);
    assert.equal(action.githubVerifiedCommit, true);
    assert.match(action.sourceTag, /^v\d+\.\d+\.\d+$/u);
  }
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
  assert.match(workflow, /rm -rf "\$GITHUB_WORKSPACE\/dist"/gu);
  assert.match(workflow, /pnpm run build/gu);
  assert.match(workflow, /pnpm pack --pack-destination "\$candidate_dir"/gu);
  assert.match(workflow, /package\/dist\/src\/api\/index\.js/gu);
  assert.match(workflow, /package\/dist\/src\/cli\/index\.js/gu);
  assert.match(workflow, /pnpm install --ignore-scripts --no-frozen-lockfile/gu);
  assert.match(
    workflow,
    /rm -rf node_modules\n\s+npm_config_offline=true pnpm install --offline --ignore-scripts --frozen-lockfile/gu
  );
  assert.match(workflow, /--read-only/gu);
  assert.match(workflow, /target=\/work,readonly/gu);
  assert.match(workflow, /target=\/candidate,readonly/gu);
  assert.match(workflow, /target=\/evidence/gu);
  assert.ok((workflow.match(/sha256sum "\$CANDIDATE_ARCHIVE"/gu) ?? []).length >= 2);
  assert.match(workflow, /HTML5ASSAY_EXPECTED_CANDIDATE_SHA256/gu);
  const acceptedUpload = workflow.indexOf('Upload accepted candidate and evidence');
  const failureUpload = workflow.indexOf('Upload failure diagnostics only');
  assert.ok(acceptedUpload > 0 && failureUpload > acceptedUpload);
  assert.equal(workflow.slice(failureUpload).includes('candidate/*.tgz'), false);
});
