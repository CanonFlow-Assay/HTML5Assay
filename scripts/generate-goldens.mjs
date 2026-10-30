import { readFile, writeFile } from 'node:fs/promises';
import { analyze, canonicalJson, toSarif } from '../dist/src/api/index.js';

const result = await analyze({
  root: 'fixtures/golden/basic',
  entries: ['index.html'],
  policy: { id: 'cff-web-strict' }
});
const outputs = {
  'fixtures/golden/basic/result.json': canonicalJson(result),
  'fixtures/golden/basic/result.sarif.json': canonicalJson(toSarif(result)),
  'fixtures/golden/basic/receipt.json': canonicalJson(result.receipt)
};
const check = process.argv.includes('--check');
let stale = false;
for (const [path, expected] of Object.entries(outputs)) {
  if (check) {
    let current = '';
    try {
      current = await readFile(path, 'utf8');
    } catch {
      /* reported below */
    }
    if (current !== expected) {
      process.stderr.write(`${path} is stale; run pnpm generate:goldens\n`);
      stale = true;
    }
  } else {
    await writeFile(path, expected);
  }
}
if (stale) process.exitCode = 1;
