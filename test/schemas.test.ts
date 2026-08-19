import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import { analyze } from '../src/api/index.js';

const loadJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

const validators = async (): Promise<Readonly<Record<string, ValidateFunction>>> => {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    formats: {
      date: /^\d{4}-\d{2}-\d{2}$/u,
      'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u
    }
  });
  const files = [
    'finding',
    'receipt',
    'result',
    'policy',
    'page-manifest',
    'browser-evidence',
    'release-evidence'
  ];
  for (const name of files)
    ajv.addSchema((await loadJson(`schemas/${name}.schema.json`)) as AnySchema);
  return Object.fromEntries(
    files.map((name) => {
      const schemaId = {
        'page-manifest': 'cff.page-manifest.v1',
        policy: 'cff.html5assay.policy.v1',
        finding: 'cff.assay.finding.v1',
        receipt: 'cff.assay.receipt.v1',
        result: 'cff.assay.result.v1',
        'browser-evidence': 'html5assay.browser-evidence.v1',
        'release-evidence': 'html5assay.release-evidence.v1'
      }[name];
      if (schemaId === undefined) throw new Error(`Unknown schema ${name}`);
      const validate = ajv.getSchema(`https://canonflow.dev/schemas/${schemaId}.json`);
      if (validate === undefined) throw new Error(`Missing schema validator ${name}`);
      return [name, validate];
    })
  );
};

void test('published schemas accept emitted artifacts and reviewed data packs', async () => {
  const validate = await validators();
  for (const policy of ['strict', 'balanced']) {
    const value = await loadJson(`policies/cff-web-${policy}-1.0.0.json`);
    assert.equal(validate.policy?.(value), true, JSON.stringify(validate.policy?.errors));
  }
  const manifest = await loadJson('playground/manifest.json');
  assert.equal(
    validate['page-manifest']?.(manifest),
    true,
    JSON.stringify(validate['page-manifest']?.errors)
  );
  const releaseEvidence = await loadJson('release-evidence/0.1.0.json');
  assert.equal(
    validate['release-evidence']?.(releaseEvidence),
    true,
    JSON.stringify(validate['release-evidence']?.errors)
  );

  const root = await mkdtemp(join(tmpdir(), 'html5assay-schema-'));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html lang="en"><title>Schema</title><body><a href="#main">Skip to primary content</a><main id="main"><h1>Schema</h1><button onclick="bad()">Run</button></main></body></html>'
    );
    const result = await analyze({
      root,
      entries: ['index.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(validate.result?.(result), true, JSON.stringify(validate.result?.errors));
    assert.equal(
      validate.receipt?.(result.receipt),
      true,
      JSON.stringify(validate.receipt?.errors)
    );
    assert.ok(result.findings.length > 0);
    for (const finding of result.findings)
      assert.equal(validate.finding?.(finding), true, JSON.stringify(validate.finding?.errors));

    const tampered = structuredClone(result.receipt) as unknown as {
      toolchain: { htmlParser: string };
    };
    tampered.toolchain.htmlParser = 'unknown/0';
    assert.equal(validate.receipt?.(tampered), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
