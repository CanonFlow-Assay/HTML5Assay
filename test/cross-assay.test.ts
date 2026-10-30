import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyze, canonicalJson } from '../src/api/index.js';

interface Projection {
  readonly assayId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly path: string;
  readonly range: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
}

const identity = (finding: Projection): string =>
  canonicalJson([
    finding.assayId,
    finding.ruleId,
    finding.ruleVersion,
    finding.path,
    finding.range
  ]);

void test('a CFF host can preserve foreign receipts and five-part finding identities', async () => {
  const fixture = JSON.parse(
    await readFile('fixtures/integration/cross-assay-bundle.json', 'utf8')
  ) as {
    readonly foreignReceipts: readonly unknown[];
    readonly findingProjections: readonly Projection[];
  };
  const root = await mkdtemp(join(tmpdir(), 'html5assay-cross-assay-'));
  try {
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html lang="en"><title>Bundle</title><body><main><button onclick="run()">Run</button></main></body></html>'
    );
    const result = await analyze({
      root,
      entries: ['index.html'],
      policy: { id: 'cff-web-strict' }
    });
    const local = result.findings.map(
      (finding): Projection => ({
        assayId: result.assay.id,
        ruleId: finding.ruleId,
        ruleVersion: finding.ruleVersion,
        path: finding.path,
        range: {
          start: { line: finding.range.start.line, column: finding.range.start.column },
          end: { line: finding.range.end.line, column: finding.range.end.column }
        }
      })
    );
    const hostBundle = {
      schemaVersion: 'cff.assay.bundle.v1',
      receipts: [...fixture.foreignReceipts, result.receipt],
      findings: [...fixture.findingProjections, ...local]
    };
    const roundTrip = JSON.parse(canonicalJson(hostBundle)) as typeof hostBundle;
    assert.deepEqual(roundTrip.receipts.slice(0, 2), fixture.foreignReceipts);
    assert.deepEqual(roundTrip.receipts[2], result.receipt);
    const identities = roundTrip.findings.map(identity);
    assert.equal(new Set(identities).size, identities.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
