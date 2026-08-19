import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);

void test('separate browser harness declares the complete network-blocked qualification matrix', async () => {
  const config = JSON.parse(await readFile('browser-harness/config.json', 'utf8')) as {
    readonly network: string;
    readonly target: string;
    readonly flowTarget: string;
    readonly browsers: readonly string[];
    readonly viewports: readonly number[];
    readonly probes: readonly string[];
    readonly humanApprovalRequired: boolean;
  };
  assert.equal(config.network, 'loopback-only');
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
