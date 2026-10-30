import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyze, type PolicyPack } from '../src/api/index.js';

void test('severity and outcome policy mutations remain explicit in result mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'html5assay-policy-mutation-'));
  try {
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html lang="en"><title>Mutation</title><body><a href="#main">Jump to content</a><main id="main"><h1>Mutation</h1><button onclick="run()">Run</button></main></body></html>'
    );
    const base = JSON.parse(
      await readFile('policies/cff-web-strict-1.0.0.json', 'utf8')
    ) as PolicyPack;
    const run = async (level: 'blocking' | 'advisory' | 'off') => {
      const policy = {
        ...base,
        id: `mutation-${level}`,
        levels: { ...base.levels, 'H5A-SAFE-002': level }
      };
      await writeFile(join(root, 'policy.json'), JSON.stringify(policy));
      return analyze({
        root,
        entries: ['index.html'],
        policy: { id: policy.id, path: 'policy.json' }
      });
    };

    const blocking = await run('blocking');
    assert.equal(blocking.verdict, 'Fail');
    assert.equal(
      blocking.evaluations.find((item) => item.ruleId === 'H5A-SAFE-002')?.outcome,
      'failed'
    );
    assert.equal(
      blocking.findings.find((item) => item.ruleId === 'H5A-SAFE-002')?.level,
      'blocking'
    );

    const advisory = await run('advisory');
    assert.notEqual(advisory.verdict, 'Fail');
    assert.equal(
      advisory.evaluations.find((item) => item.ruleId === 'H5A-SAFE-002')?.outcome,
      'failed'
    );
    assert.equal(
      advisory.findings.find((item) => item.ruleId === 'H5A-SAFE-002')?.level,
      'advisory'
    );
    assert.ok(advisory.counts.advisory >= 1);

    const off = await run('off');
    const offEvaluation = off.evaluations.find((item) => item.ruleId === 'H5A-SAFE-002');
    assert.equal(offEvaluation?.outcome, 'untested');
    assert.equal(offEvaluation?.level, 'blocking');
    assert.equal(offEvaluation?.findingCount, 0);
    assert.equal(
      off.findings.some((item) => item.ruleId === 'H5A-SAFE-002'),
      false
    );
    assert.ok(off.counts.inconclusive >= 1);
    assert.equal(off.verdict, 'Inconclusive');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
