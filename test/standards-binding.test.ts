import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalDigest, standardsIdentity } from '../src/api/index.js';

void test('standards snapshot, authority set, generated catalogue, and change record move together', async () => {
  const snapshot = JSON.parse(await readFile('standards/standards-snapshot.json', 'utf8')) as {
    readonly authorities: unknown;
  };
  assert.equal(canonicalDigest(snapshot).value, standardsIdentity.digest.value);
  assert.equal(
    canonicalDigest(snapshot.authorities).value,
    standardsIdentity.authoritySetDigest.value
  );

  const generated = JSON.parse(await readFile('rules/catalog.json', 'utf8')) as {
    readonly standards: {
      readonly digest: { readonly value: string };
      readonly authoritySetDigest: { readonly value: string };
    };
  };
  assert.equal(generated.standards.digest.value, standardsIdentity.digest.value);
  assert.equal(
    generated.standards.authoritySetDigest.value,
    standardsIdentity.authoritySetDigest.value
  );
  assert.match(await readFile('CHANGELOG.md', 'utf8'), /0\.1\.0/u);
});
