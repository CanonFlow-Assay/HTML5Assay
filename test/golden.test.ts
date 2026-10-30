import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyze, canonicalJson, toSarif } from '../src/api/index.js';

void test('canonical JSON, SARIF, and receipt outputs match reviewed goldens', async () => {
  const result = await analyze({
    root: 'fixtures/golden/basic',
    entries: ['index.html'],
    policy: { id: 'cff-web-strict' }
  });
  const expected = await Promise.all([
    readFile('fixtures/golden/basic/result.json', 'utf8'),
    readFile('fixtures/golden/basic/result.sarif.json', 'utf8'),
    readFile('fixtures/golden/basic/receipt.json', 'utf8')
  ]);
  assert.equal(canonicalJson(result), expected[0]);
  assert.equal(canonicalJson(toSarif(result)), expected[1]);
  assert.equal(canonicalJson(result.receipt), expected[2]);
});
