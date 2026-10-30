import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { analyze, ruleCatalog, type PageManifest, type RuleOutcome } from '../src/api/index.js';

const write = async (root: string, path: string, value: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
};

void test('every catalogue example produces its declared atomic outcome', async () => {
  const mismatches: string[] = [];
  for (const rule of ruleCatalog) {
    for (const [index, example] of rule.examples.entries()) {
      const root = await mkdtemp(join(tmpdir(), 'html5assay-catalog-'));
      try {
        await write(root, 'index.html', example.html);
        for (const [path, value] of Object.entries(example.context?.assets ?? {}))
          await write(root, path, value);
        for (const [path, size] of Object.entries(example.context?.assetSizes ?? {}))
          await write(root, path, 'x'.repeat(size));
        let manifestPath: string | undefined;
        if (example.context?.pageKind !== undefined || example.context?.fragment !== undefined) {
          const manifest: PageManifest = {
            schemaVersion: 'cff.page-manifest.v1',
            pages:
              example.context.pageKind === undefined
                ? {}
                : { 'index.html': example.context.pageKind },
            requiredTheme: 'cff-evidence/1.0.0',
            ...(example.context.fragment === undefined
              ? {}
              : { fragments: { 'index.html': example.context.fragment } })
          };
          await write(root, 'manifest.json', JSON.stringify(manifest));
          manifestPath = 'manifest.json';
        }
        const result = await analyze({
          root,
          entries: ['index.html'],
          policy: { id: 'cff-web-strict' },
          ...(manifestPath === undefined ? {} : { manifest: manifestPath })
        });
        const evaluation = result.evaluations.find((item) => item.ruleId === rule.id);
        const actual: RuleOutcome | 'missing' = evaluation?.outcome ?? 'missing';
        if (actual !== example.outcome)
          mismatches.push(`${rule.id}[${index}] expected ${example.outcome}, got ${actual}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  assert.deepEqual(mismatches, []);
});

void test('catalogue cantTell examples track every evaluator capability', async () => {
  const source = await readFile('src/rules/evaluate.ts', 'utf8');
  const file = ts.createSourceFile(
    'evaluate.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const containsCantTell = (node: ts.Node): boolean => {
    let found =
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'cantTell') ||
      (ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === 'outcome') ||
          (ts.isStringLiteral(node.name) && node.name.text === 'outcome')) &&
        ts.isStringLiteral(node.initializer) &&
        node.initializer.text === 'cantTell');
    if (!found) ts.forEachChild(node, (child) => (found ||= containsCantTell(child)));
    return found;
  };
  const evaluatorCapabilities = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCaseClause(node) &&
      ts.isStringLiteral(node.expression) &&
      /^H5A-(?:DOC|SEM|A11Y|CSS|SAFE|CFF|PERF|THEME)-\d{3}$/u.test(node.expression.text) &&
      containsCantTell(node)
    ) {
      evaluatorCapabilities.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const catalogueCapabilities = new Set(
    ruleCatalog
      .filter((rule) => rule.examples.some((example) => example.outcome === 'cantTell'))
      .map((rule) => rule.id)
  );
  const required = ['H5A-SEM-001', 'H5A-SEM-002', 'H5A-A11Y-005', 'H5A-CSS-001', 'H5A-SAFE-001'];
  assert.deepEqual(
    required.filter((ruleId) => !catalogueCapabilities.has(ruleId)),
    []
  );
  assert.deepEqual([...catalogueCapabilities].sort(), [...evaluatorCapabilities].sort());
});
