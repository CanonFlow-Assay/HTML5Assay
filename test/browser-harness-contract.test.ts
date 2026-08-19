import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

const execute = promisify(execFile);

void test('separate browser harness declares the complete network-blocked qualification matrix', async () => {
  const config = JSON.parse(await readFile('browser-harness/config.json', 'utf8')) as {
    readonly network: {
      readonly browserRequests: string;
      readonly serviceWorkers: string;
      readonly hostDenial: string;
    };
    readonly target: string;
    readonly flowTarget: string;
    readonly browsers: readonly string[];
    readonly viewports: readonly number[];
    readonly probes: readonly string[];
    readonly humanApprovalRequired: boolean;
  };
  assert.deepEqual(config.network, {
    browserRequests: 'loopback-only',
    serviceWorkers: 'block',
    hostDenial: 'docker-network-none'
  });
  assert.equal(config.target, '/playground/index.html');
  assert.equal(config.flowTarget, '/browser-harness/qualification.html');
  assert.deepEqual(config.browsers, ['chromium', 'firefox', 'webkit']);
  assert.deepEqual(config.viewports, [320, 768, 1024, 1440]);
  for (const probe of [
    'keyboard-order',
    'focus-visibility',
    'zoom-200',
    'reduced-motion',
    'forced-colors',
    'horizontal-overflow',
    'native-dialog',
    'native-popover',
    'page-state-recovery'
  ])
    assert.ok(config.probes.includes(probe));
  assert.equal(config.humanApprovalRequired, true);
  const runner = await readFile('browser-harness/runner.mjs', 'utf8');
  const qualification = await readFile('browser-harness/qualification.html', 'utf8');
  for (const mode of ['default', 'zoom-200', 'reduced-motion', 'forced-colors', 'native-flows'])
    assert.match(runner, new RegExp(`mode: ["']${mode}["']`, 'u'));
  assert.match(runner, /process\.exitCode\s*=\s*1/u);
  assert.match(runner, /new Set\(keys\)\.size === keyboard\.expected/u);
  assert.equal(runner.match(/browser\.newContext\(/gu)?.length, 1);
  assert.match(runner, /serviceWorkers:\s*['"]block['"]/u);
  assert.match(runner, /probeHostNetworkDenial/u);
  for (const field of [
    'gitCommit',
    'archiveSha256',
    'playwrightVersion',
    'browserRevisions',
    'operatingSystem',
    'nodeVersion',
    'executionTime',
    'evidenceDigest'
  ])
    assert.ok(runner.includes(field), `browser evidence is missing ${field}`);
  assert.equal(runner.includes("document.createElement('dialog"), false);
  assert.equal(runner.includes('document.createElement("dialog'), false);
  for (const id of [
    'open-dialog',
    'close-dialog',
    'open-popover',
    'review-popover',
    'recovery-value'
  ])
    assert.match(qualification, new RegExp(`id=["']${id}["']`, 'u'));
  const validation = await execute(process.execPath, ['browser-harness/runner.mjs', '--validate']);
  assert.match(validation.stdout, /contract valid/u);
});

void test('browser evidence schema and digest bind the full qualification environment', async () => {
  const { digestEvidence } = (await import(
    pathToFileURL(resolve('browser-harness/evidence.mjs')).href
  )) as {
    readonly digestEvidence: (value: unknown) => {
      readonly algorithm: 'sha-256';
      readonly value: string;
    };
  };
  const { expectedBrowserResults } = (await import(
    pathToFileURL(resolve('browser-harness/matrix.mjs')).href
  )) as {
    readonly expectedBrowserResults: () => ReadonlyArray<{
      readonly browser: string;
      readonly width: number;
      readonly mode: string;
    }>;
  };
  const lock = JSON.parse(await readFile('browser-harness/environment-lock.json', 'utf8')) as {
    readonly playwright: { readonly version: string };
    readonly browsers: ReadonlyArray<{
      readonly name: string;
      readonly revision: string;
      readonly browserVersion: string;
    }>;
    readonly container: object;
  };
  const payload = {
    schemaVersion: 'html5assay.browser-evidence.v1',
    authoritative: false,
    candidate: {
      gitCommit: 'a'.repeat(40),
      archiveSha256: 'b'.repeat(64)
    },
    environment: {
      playwrightVersion: lock.playwright.version,
      browserRevisions: lock.browsers,
      browserExecutables: lock.browsers.map((browser) => ({
        name: browser.name,
        version: browser.browserVersion
      })),
      operatingSystem: { platform: 'linux', release: 'test', architecture: 'x64' },
      nodeVersion: 'v24.19.0',
      container: lock.container
    },
    executionTime: {
      startedAt: '2026-08-19T00:00:00.000Z',
      finishedAt: '2026-08-19T00:00:01.000Z',
      durationMilliseconds: 1000
    },
    network: {
      browserRequests: 'loopback-only',
      serviceWorkers: 'block',
      hostDenial: {
        required: 'docker-network-none',
        declared: 'docker-network-none',
        probe: { denied: true, detail: 'ENETUNREACH' }
      }
    },
    target: '/playground/index.html',
    flowTarget: '/browser-harness/qualification.html',
    results: expectedBrowserResults(),
    failures: [],
    result: 'Pass',
    humanApprovalRequired: true
  };
  const evidence = { ...payload, evidenceDigest: digestEvidence(payload) };
  const schema = JSON.parse(
    await readFile('schemas/browser-evidence.schema.json', 'utf8')
  ) as AnySchema;
  const ajv = new Ajv2020({
    strict: true,
    formats: { 'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u }
  });
  const validate = ajv.compile(schema);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.notDeepEqual(
    digestEvidence({ ...payload, result: 'Fail' }),
    evidence.evidenceDigest,
    'evidence digest must change when the result changes'
  );

  const root = await mkdtemp(join(tmpdir(), 'html5assay-browser-evidence-'));
  try {
    const evidencePath = join(root, 'evidence.json');
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
    const verifierEnvironment = {
      ...process.env,
      HTML5ASSAY_EXPECTED_GIT_COMMIT: payload.candidate.gitCommit,
      HTML5ASSAY_EXPECTED_CANDIDATE_SHA256: payload.candidate.archiveSha256
    };
    const verified = await execute(
      process.execPath,
      ['browser-harness/verify-evidence.mjs', evidencePath],
      { env: verifierEnvironment }
    );
    assert.match(verified.stdout, /browser evidence digest verified/u);
    await assert.rejects(
      execute(process.execPath, ['browser-harness/verify-evidence.mjs', evidencePath], {
        env: {
          ...verifierEnvironment,
          HTML5ASSAY_EXPECTED_CANDIDATE_SHA256: 'c'.repeat(64)
        }
      }),
      /does not match the post-run candidate digest/u
    );

    const completeResults = expectedBrowserResults();
    const firstResult = completeResults.at(0);
    assert.ok(firstResult !== undefined);
    const invalidMatrices = [
      { name: 'missing', results: completeResults.slice(1) },
      {
        name: 'duplicate',
        results: [...completeResults.slice(0, -1), firstResult]
      },
      {
        name: 'unexpected',
        results: [
          ...completeResults.slice(0, -1),
          { browser: 'chromium', width: 999, mode: 'default' }
        ]
      }
    ];
    for (const invalid of invalidMatrices) {
      const invalidPayload = { ...payload, results: invalid.results };
      const invalidEvidence = {
        ...invalidPayload,
        evidenceDigest: digestEvidence(invalidPayload)
      };
      const invalidPath = join(root, `${invalid.name}.json`);
      await writeFile(invalidPath, `${JSON.stringify(invalidEvidence)}\n`);
      await assert.rejects(
        execute(process.execPath, ['browser-harness/verify-evidence.mjs', invalidPath], {
          env: verifierEnvironment
        }),
        /Browser evidence matrix validation failed/u
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
