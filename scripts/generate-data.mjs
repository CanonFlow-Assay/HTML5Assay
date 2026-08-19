import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  canonicalJson,
  ruleCatalog,
  rulesetIdentity,
  standardsIdentity
} from '../dist/src/api/index.js';

const path = new URL('../rules/catalog.json', import.meta.url);
const prettierConfig = (await resolveConfig(fileURLToPath(path))) ?? {};
const generated = await format(
  canonicalJson({
    ruleset: rulesetIdentity,
    standards: standardsIdentity,
    rules: ruleCatalog
  }),
  { ...prettierConfig, parser: 'json' }
);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    /* reported below */
  }
  if (current !== generated) {
    process.stderr.write('rules/catalog.json is stale; run pnpm generate:data\n');
    process.exitCode = 1;
  }
} else {
  await writeFile(path, generated);
}
