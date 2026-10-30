import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { specimens } from '../playground/specimens.mjs';
import { reviewHTML, selectHTMLInvestigation } from '../playground/investigation.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const results = specimens.map((specimen) => {
  const review = reviewHTML(specimen.input, specimen.policy);
  assert.equal(review.verdict, specimen.expectedVerdict);
  assert.deepEqual(
    review.findings.map((f) => f.ruleId).sort(),
    [...specimen.expectedFindingIds].sort()
  );
  assert.equal(
    selectHTMLInvestigation(review, specimen.input + 'edit', specimen.policy, 1).kind,
    'ContextRequired'
  );
  return { specimen: specimen.id, inputSha256: hash(specimen.input), review };
});
const source = Object.fromEntries(
  await Promise.all(
    [
      'playground/preview.mjs',
      'playground/investigation.mjs',
      'playground/specimens.mjs',
      'scripts/try-playground.mjs'
    ].map(async (file) => [file, hash(await readFile(file))])
  )
);
const report = {
  schema: 'html5assay-playground-experiment/0.1',
  authority: 'non-authoritative-source-preview',
  toolchain: {
    node: process.version,
    pinnedNode: '24.19.0',
    matchesPin: process.version === 'v24.19.0'
  },
  source,
  results,
  checkCompletion: 'Completed',
  limits: [
    'Regex-based preview subset only; full parser/asset graph not run by this command.',
    'Balanced and strict selectors share this conservative preview subset.',
    'No browser, accessibility, release or full-rule qualification follows.'
  ]
};
if (process.argv[2]) {
  const output = resolve(process.argv[2]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify(report, null, 2));
