import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { specimens } from './specimens.mjs';
import {
  reviewHTML,
  selectHTMLInvestigation,
  validatePreviewManifest,
  reviewPreviewManifest
} from './investigation.mjs';

const clean = specimens[0].input;
test('bundled inputs retain exact digest and documented findings', () => {
  for (const specimen of specimens) {
    const result = reviewHTML(specimen.input, specimen.policy);
    assert.equal(createHash('sha256').update(specimen.input).digest('hex'), specimen.digest);
    assert.equal(result.verdict, specimen.expectedVerdict);
    assert.deepEqual(
      result.findings.map((f) => f.ruleId).sort(),
      [...specimen.expectedFindingIds].sort()
    );
  }
});
test('clean subset still needs full assay and never becomes Pass', () => {
  const result = reviewHTML(clean);
  assert.equal(result.verdict, 'Inconclusive');
  assert.equal(result.untestedRuleCount, 48);
  assert.equal(result.next.kind, 'FullAssayRequired');
});
test('real document mutations expose their corresponding defect', () => {
  const controls = [
    ['doctype', clean.replace('<!doctype html>', ''), 'H5A-DOC-001'],
    ['language', clean.replace('lang="en"', ''), 'H5A-DOC-002'],
    ['title', clean.replace(/<title>.*?<\/title>/, '<title> </title>'), 'H5A-DOC-003'],
    [
      'main',
      clean.replace('<main id="main">', '<section id="main">').replace('</main>', '</section>'),
      'H5A-SEM-001'
    ],
    ['image', clean.replace('</main>', '<img src="./local.svg"></main>'), 'H5A-A11Y-001'],
    [
      'runtime',
      clean.replace('</main>', '<script src="https://example.invalid/x.js"></script></main>'),
      'H5A-SAFE-001'
    ],
    [
      'handler',
      clean.replace('</main>', '<button onclick="throw 1">Run</button></main>'),
      'H5A-SAFE-002'
    ]
  ];
  for (const [id, input, expected] of controls) {
    const result = reviewHTML(input);
    assert.equal(result.verdict, 'Fail', id);
    assert.ok(
      result.findings.some((f) => f.ruleId === expected),
      id
    );
    assert.equal(result.next.kind, 'ReviewFinding', id);
  }
});
test('changed source or policy cannot reuse a review', () => {
  const result = reviewHTML(clean);
  assert.equal(
    selectHTMLInvestigation(result, clean + ' ', 'cff-web-strict', 1).kind,
    'ContextRequired'
  );
  assert.equal(
    selectHTMLInvestigation(result, clean, 'cff-web-balanced', 1).kind,
    'ContextRequired'
  );
  assert.deepEqual(selectHTMLInvestigation(result, clean, 'cff-web-strict', 1), result.next);
});
test('invalid budgets, empty input and unknown policies stay visible', () => {
  const result = reviewHTML(clean);
  for (const budget of [0, -1, NaN, Infinity, 1.5])
    assert.equal(
      selectHTMLInvestigation(result, clean, 'cff-web-strict', budget).kind,
      'ContextRequired'
    );
  assert.equal(reviewHTML('').next.kind, 'ContextRequired');
  assert.throws(() => reviewHTML(clean, 'unknown'), TypeError);
});
test('preview is deterministic and supplied scripts remain inert text', () => {
  const input = clean.replace(
    '</main>',
    '<script>throw new Error("must never execute")</script></main>'
  );
  assert.deepEqual(reviewHTML(input), reviewHTML(input));
});
test('manifest schema validation rejects malformed, unknown-policy or getter-backed specimen envelopes before rendering', () => {
  const accepted = validatePreviewManifest({
    id: 'specimen-clean',
    input: clean,
    policy: 'cff-web-strict'
  });
  assert.equal(accepted.kind, 'ManifestAccepted');
  assert.equal(reviewPreviewManifest({ id: 'specimen-clean', input: clean, policy: 'cff-web-strict' }).verdict, 'Inconclusive');

  for (const bad of [
    null,
    [],
    { id: '', input: clean, policy: 'cff-web-strict' },
    { id: 's1', policy: 'cff-web-strict' },
    { id: 's1', input: 42, policy: 'cff-web-strict' },
    { id: 's1', input: clean, policy: 'unknown-policy' }
  ]) {
    const reviewed = reviewPreviewManifest(bad);
    assert.equal(reviewed.verdict, 'Inconclusive');
    assert.equal(reviewed.next.kind, 'ContextRequired');
  }

  let getterReads = 0;
  const withGetter = { id: 's1', policy: 'cff-web-strict' };
  Object.defineProperty(withGetter, 'input', {
    get() {
      getterReads += 1;
      return clean;
    },
    enumerable: true
  });
  const getterReviewed = reviewPreviewManifest(withGetter);
  assert.equal(getterReviewed.next.kind, 'ContextRequired');
  assert.equal(getterReads, 0);
});
