import { strict as assert } from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { analyze, canonicalJson, type AnalyzeResult } from '../src/api/index.js';

const cli = resolve('dist/src/cli/index.js');

const withFixture = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'html5assay-cli-'));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const write = async (root: string, path: string, contents: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
};

const runCliWithEnvironment = (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...environment }
  });

const runCli = (arguments_: readonly string[]): SpawnSyncReturns<string> =>
  runCliWithEnvironment(arguments_, { LC_ALL: 'C', TZ: 'UTC' });

const nativeDocument = (body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CLI fixture</title></head>
<body><a href="#main">Skip to primary content</a><main id="main"><h1>CLI fixture</h1>${body}</main></body>
</html>
`;

void test('CLI exposes the catalogue and explain surfaces and rejects invalid use', () => {
  const catalogue = runCli(['catalog', '--format', 'json']);
  assert.equal(catalogue.status, 0, catalogue.stderr);
  const value = JSON.parse(catalogue.stdout) as { readonly rules: readonly unknown[] };
  assert.equal(value.rules.length, 58);

  const explained = runCli(['explain', 'h5a-doc-001']);
  assert.equal(explained.status, 0, explained.stderr);
  assert.equal((JSON.parse(explained.stdout) as { readonly id: string }).id, 'H5A-DOC-001');

  const invalid = runCli(['not-a-command']);
  assert.equal(invalid.status, 3);
  assert.match(invalid.stderr, /^ToolFailure: Unknown command not-a-command/mu);
});

void test('CLI uses exact verdict exit codes and JSON/SARIF formats', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument('<button type="button">Run</button>'));
    const incomplete = runCli(['check', join(root, 'index.html'), '--format', 'json']);
    assert.equal(incomplete.status, 2, incomplete.stderr);
    assert.equal((JSON.parse(incomplete.stdout) as AnalyzeResult).verdict, 'Inconclusive');

    await write(
      root,
      'index.html',
      nativeDocument('<button type="button" onclick="runTask()">Run</button>')
    );
    const failed = runCli(['check', join(root, 'index.html'), '--format', 'sarif']);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal((JSON.parse(failed.stdout) as { readonly version: string }).version, '2.1.0');

    await write(
      root,
      'index.html',
      nativeDocument('<link rel="stylesheet" href="bad.css"><p>Malformed CSS.</p>')
    );
    await write(root, 'bad.css', '.broken { color: red;');
    const toolFailure = runCli(['check', join(root, 'index.html'), '--format', 'json']);
    assert.equal(toolFailure.status, 3, toolFailure.stderr);
    assert.equal((JSON.parse(toolFailure.stdout) as AnalyzeResult).verdict, 'ToolFailure');

    const missing = runCli(['check', join(root, 'missing.html')]);
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /^ToolFailure:/mu);
  });
});

void test('CLI JSON equals the public library canonical result', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument('<button type="button" onclick="runTask()">Run</button>')
    );
    const result = await analyze({
      root,
      entries: ['index.html'],
      policy: { id: 'cff-web-strict' }
    });
    const command = runCli(['check', join(root, 'index.html'), '--format', 'json']);
    assert.equal(command.status, 1, command.stderr);
    assert.equal(command.stdout, canonicalJson(result));
  });
});

void test('CLI directory checks honor manifest root and entries exactly once', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'site/index.html',
      '<!doctype html><html lang="en"><head><title>Manifest root</title></head><body>' +
        '<header>HTML5Assay 0.1.0 Specified static source evidence authority</header>' +
        '<nav>Primary</nav><main><h1>Manifest root</h1></main><footer>Footer</footer>' +
        '</body></html>'
    );
    await write(
      root,
      'manifest.json',
      JSON.stringify({
        schemaVersion: 'cff.page-manifest.v1',
        root: 'site',
        entries: ['index.html'],
        pages: { 'index.html': 'overview' },
        requiredTheme: 'cff-evidence/1.0.0'
      })
    );
    const library = await analyze({
      root,
      entries: [],
      manifest: 'manifest.json',
      policy: { id: 'cff-web-strict' }
    });
    const command = runCli(['check', root, '--manifest', 'manifest.json', '--format', 'json']);
    const expectedStatus =
      library.verdict === 'Pass'
        ? 0
        : library.verdict === 'Fail'
          ? 1
          : library.verdict === 'Inconclusive'
            ? 2
            : 3;
    assert.equal(command.status, expectedStatus, command.stderr);
    assert.equal(command.stdout, canonicalJson(library));
  });
});

void test('canonical CLI output is independent of locale and time zone', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument('<button type="button" onclick="runTask()">Run</button>')
    );
    const arguments_ = ['check', join(root, 'index.html'), '--format', 'json'];
    const baseline = runCliWithEnvironment(arguments_, { LC_ALL: 'C', TZ: 'UTC' });
    const shifted = runCliWithEnvironment(arguments_, {
      LANG: 'tr_TR.UTF-8',
      LC_ALL: 'tr_TR.UTF-8',
      TZ: 'Pacific/Kiritimati'
    });
    assert.equal(baseline.status, 1, baseline.stderr);
    assert.equal(shifted.status, baseline.status, shifted.stderr);
    assert.equal(shifted.stdout, baseline.stdout);
  });
});

void test('verify-receipt accepts emitted identity and rejects a changed ruleset digest', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument('<button type="button">Run</button>'));
    const result = await analyze({
      root,
      entries: ['index.html'],
      policy: { id: 'cff-web-strict' }
    });
    const receiptPath = join(root, 'receipt.json');
    await writeFile(receiptPath, canonicalJson(result.receipt));
    const valid = runCli(['verify-receipt', receiptPath]);
    assert.equal(valid.status, 0, valid.stderr);
    const verification = JSON.parse(valid.stdout) as {
      readonly reasons: readonly string[];
      readonly unverifiedBindings: readonly string[];
      readonly valid: boolean;
      readonly verified: readonly string[];
    };
    assert.equal(verification.valid, true);
    assert.deepEqual(verification.reasons, []);
    assert.ok(verification.verified.includes('current ruleset digest'));
    assert.ok(verification.unverifiedBindings.includes('canonical result artifact'));

    const changed = structuredClone(result.receipt) as unknown as {
      ruleset: { digest: { value: string } };
    };
    changed.ruleset.digest.value = 'f'.repeat(64);
    await writeFile(receiptPath, canonicalJson(changed));
    const invalid = runCli(['verify-receipt', receiptPath]);
    assert.equal(invalid.status, 3, invalid.stderr);
    assert.equal((JSON.parse(invalid.stdout) as { readonly valid: boolean }).valid, false);
  });
});
