import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

void test('source-map annotations remain inert and cannot read outside canary files', async () => {
  assert.match(
    await readFile('src/parse/css.ts', 'utf8'),
    /postcss\.parse\(source, \{ from: undefined, map: false \}\)/u,
    'the parser must explicitly disable automatic PostCSS source-map loading'
  );
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'html5assay-source-map-'));
  const fixtureRoot = join(temporaryRoot, 'fixture');
  const canaryPath = join(temporaryRoot, 'outside-canary.map');
  const symlinkPath = join(fixtureRoot, 'linked-canary.map');
  const firstCanary = 'CANARY_SECRET_FIRST_4f690860';
  const secondCanary = 'CANARY_SECRET_SECOND_0e27b87d';
  await mkdir(fixtureRoot);
  await writeFile(canaryPath, firstCanary);
  await symlink(canaryPath, symlinkPath, 'file');
  await writeFile(
    join(fixtureRoot, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Map probe</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>Map probe</h1></main></body></html>'
  );

  const mutableFs = require('node:fs') as {
    readFileSync: (...arguments_: readonly unknown[]) => unknown;
  };
  const originalReadFileSync = mutableFs.readFileSync;
  const guardedPaths = new Set([resolve(canaryPath), resolve(symlinkPath)]);
  const forbiddenReads: string[] = [];
  mutableFs.readFileSync = (...arguments_: readonly unknown[]): unknown => {
    const requested = arguments_[0];
    if (typeof requested === 'string' && guardedPaths.has(resolve(requested))) {
      forbiddenReads.push(resolve(requested));
      throw new Error(`forbidden source-map read: ${requested}`);
    }
    return Reflect.apply(originalReadFileSync, mutableFs, arguments_);
  };
  syncBuiltinESMExports();

  try {
    const [{ analyze }, { parseCss }] = await Promise.all([
      import('../src/api/index.js'),
      import('../src/parse/css.js')
    ]);
    const inlineMap = `data:application/json;base64,${Buffer.from(
      JSON.stringify({ version: 3, sources: ['input.css'], mappings: '' })
    ).toString('base64')}`;
    const annotations = [
      resolve(canaryPath),
      '../outside-canary.map',
      '%2e%2e%2foutside-canary.map',
      'linked-canary.map',
      inlineMap
    ];

    for (const annotation of annotations) {
      const css = `body { color: CanvasText; }\n/*# sourceMappingURL=${annotation} */`;
      const parsed = parseCss('styles.css', css);
      const sourceMaps = parsed.urls.filter((reference) => reference.kind === 'source-map');
      assert.deepEqual(
        sourceMaps.map((reference) => reference.value),
        [annotation],
        `source-map URL was not retained as inert evidence: ${annotation}`
      );
      assert.doesNotMatch(JSON.stringify(parsed), new RegExp(firstCanary, 'u'));

      await writeFile(join(fixtureRoot, 'styles.css'), css);
      let serialized: string;
      try {
        const result = await analyze({
          root: fixtureRoot,
          entries: ['index.html'],
          policy: { id: 'cff-web-strict' }
        });
        serialized = JSON.stringify(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, new RegExp(`${firstCanary}|${secondCanary}`, 'u'));
        throw error;
      }
      assert.doesNotMatch(serialized, new RegExp(`${firstCanary}|${secondCanary}`, 'u'));
      assert.ok(
        !serialized.includes(temporaryRoot),
        'assay result leaked an absolute fixture path'
      );
    }

    const absoluteCss = `body { color: CanvasText; }\n/*# sourceMappingURL=${resolve(canaryPath)} */`;
    await writeFile(join(fixtureRoot, 'styles.css'), absoluteCss);
    const firstResult = JSON.stringify(
      await analyze({
        root: fixtureRoot,
        entries: ['index.html'],
        policy: { id: 'cff-web-strict' }
      })
    );
    await writeFile(canaryPath, secondCanary);
    const secondResult = JSON.stringify(
      await analyze({
        root: fixtureRoot,
        entries: ['index.html'],
        policy: { id: 'cff-web-strict' }
      })
    );
    assert.equal(firstResult, secondResult, 'outside canary bytes changed the assay result');
    assert.deepEqual(forbiddenReads, [], 'PostCSS attempted to read a source-map target');
  } finally {
    mutableFs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
