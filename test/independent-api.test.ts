import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import {
  analyze,
  canonicalDigest,
  canonicalJson,
  ruleCatalog,
  rulesetIdentity,
  standardsIdentity,
  toSarif,
  verifyReceipt,
  type AnalyzeRequest,
  type AnalyzeResult,
  type Finding
} from '../src/api/index.js';
import { strictPolicy } from '../src/policy/builtins.js';

const withFixture = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'html5assay-api-'));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const write = async (root: string, path: string, contents: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
};

const nativeDocument = (body = ''): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Independent fixture</title></head>
<body>
  <a href="#main">Skip to primary content</a>
  <main id="main"><h1>Independent fixture</h1>${body}</main>
</body>
</html>
`;

const requestFor = (root: string): AnalyzeRequest => ({
  root,
  entries: ['index.html'],
  policy: { id: 'cff-web-strict' }
});

const compareFindings = (left: Finding, right: Finding): number => {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.range.start.offset !== right.range.start.offset) {
    return left.range.start.offset - right.range.start.offset;
  }
  if (left.ruleId !== right.ruleId) return left.ruleId < right.ruleId ? -1 : 1;
  return left.evidenceDigest.value < right.evidenceDigest.value
    ? -1
    : left.evidenceDigest.value > right.evidenceDigest.value
      ? 1
      : 0;
};

void test('catalogue is complete, unique, versioned, and explicit about automation limits', () => {
  assert.equal(ruleCatalog.length, 58);
  assert.equal(new Set(ruleCatalog.map((rule) => rule.id)).size, 58);
  for (const rule of ruleCatalog) {
    assert.match(rule.id, /^H5A-(?:DOC|SEM|A11Y|CSS|SAFE|CFF|PERF|THEME)-\d{3}$/u);
    assert.equal(rule.version, '1.0.0');
    assert.ok(rule.applicability.length > 0, rule.id);
    assert.ok(rule.expectations.length > 0, rule.id);
    assert.ok(rule.assumptions.length > 0, rule.id);
    assert.deepEqual(
      ['passed', 'failed', 'inapplicable'].filter(
        (outcome) => !rule.examples.some((example) => example.outcome === outcome)
      ),
      [],
      rule.id
    );
    assert.ok(rule.standards.length > 0, rule.id);
    assert.ok(
      rule.standards.every((mapping) => mapping.automationLimit.length > 0),
      rule.id
    );
  }
});

void test('pinned standards snapshot and generated catalogue identities cannot drift', async () => {
  const snapshot = JSON.parse(await readFile('standards/standards-snapshot.json', 'utf8')) as {
    readonly authorities: readonly unknown[];
  };
  const generated = JSON.parse(await readFile('rules/catalog.json', 'utf8')) as {
    readonly ruleset: unknown;
    readonly standards: unknown;
  };
  assert.deepEqual(canonicalDigest(snapshot), standardsIdentity.digest);
  assert.deepEqual(canonicalDigest(snapshot.authorities), standardsIdentity.authoritySetDigest);
  assert.deepEqual(generated.standards, standardsIdentity);
  assert.deepEqual(generated.ruleset, rulesetIdentity);
});

void test('adversarial fixture paths reject portable traversal and absolute forms', async () => {
  const schema = JSON.parse(
    await readFile('schemas/adversarial-fixture.schema.json', 'utf8')
  ) as AnySchema;
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const invalidPaths = [
    '../outside.html',
    '..\\outside.html',
    'nested/../../outside.html',
    'C:/outside.html',
    'C:\\outside.html',
    '\\outside.html',
    '\\\\server\\share\\outside.html',
    '/outside.html'
  ];
  for (const path of invalidPaths) {
    const fixture = {
      schemaVersion: 'html5assay.adversarial-fixture.v1',
      id: 'portable-path',
      description: 'Portable containment regression',
      entries: ['index.html'],
      files: { [path]: '<!doctype html><title>Outside</title>' },
      policy: { base: 'cff-web-strict' },
      expected: { verdict: 'Fail' }
    };
    assert.equal(validate(fixture), false, path);
  }
});

void test('public analysis is deterministic, canonical, path-normalized, and receipt-bound', async () => {
  await withFixture(async (root) => {
    const firstRoot = join(root, 'first-root');
    const secondRoot = join(root, 'second-root');
    await write(firstRoot, 'index.html', nativeDocument());
    await write(secondRoot, 'index.html', nativeDocument());
    const first = await analyze(requestFor(firstRoot));
    const second = await analyze(requestFor(secondRoot));
    assert.notEqual(first.verdict, 'ToolFailure');
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.doesNotMatch(
      canonicalJson(first),
      new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u')
    );
    assert.deepEqual(first.findings, first.findings.slice().sort(compareFindings));
    assert.equal(first.subject.root, '.');
    assert.ok(first.findings.every((finding) => !finding.path.startsWith('/')));

    const { receipt, ...core } = first;
    assert.deepEqual(receipt.resultDigest, canonicalDigest(core));
    assert.deepEqual(receipt.findingsDigest, canonicalDigest(first.findings));
    const verification = verifyReceipt(receipt);
    assert.equal(verification.valid, true);
    assert.deepEqual(verification.reasons, []);
    assert.ok(verification.verified.includes('current ruleset digest'));
    assert.ok(verification.unverifiedBindings.includes('subject bytes'));

    const sarif = toSarif(first) as {
      readonly version: string;
      readonly runs: ReadonlyArray<{
        readonly tool: { readonly driver: { readonly rules: readonly unknown[] } };
        readonly results: readonly unknown[];
      }>;
    };
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0]?.tool.driver.rules.length, 58);
    assert.equal(sarif.runs[0]?.results.length, first.findings.length);
  });
});

void test('a fully evidenced common semantic document can achieve strict Pass', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">' +
        '<title>Strict pass fixture</title></head><body>' +
        '<a href="#main">Skip to primary content</a>' +
        '<main id="main"><h1>Strict pass fixture</h1><p>Static evidence is complete.</p></main>' +
        '</body></html>'
    );
    const result = await analyze(requestFor(root));
    const unresolvedBlocking = result.evaluations
      .filter(
        (evaluation) =>
          evaluation.level === 'blocking' &&
          ['failed', 'cantTell', 'untested'].includes(evaluation.outcome)
      )
      .map(({ ruleId, outcome }) => ({ ruleId, outcome }));
    assert.deepEqual(unresolvedBlocking, []);
    assert.equal(result.verdict, 'Pass');
  });
});

void test('exact-covered elements enforce their frozen HTML content models', async () => {
  await withFixture(async (root) => {
    const cases = [
      '<meta charset="utf-8"><main><h1>Metadata placement</h1></main>',
      '<strong><div>Block content</div></strong><main><h1>Phrasing content</h1></main>',
      '<header><header>Nested header</header></header><main><h1>Header content</h1></main>'
    ];
    const outcomes: Array<{
      outcome: string | undefined;
      path: string | undefined;
      offset: number;
    }> = [];
    for (const [index, body] of cases.entries()) {
      const path = `case-${index}.html`;
      await write(
        root,
        path,
        '<!doctype html><html lang="en"><head><title>Content model</title></head>' +
          `<body>${body}</body></html>`
      );
      const result = await analyze({
        root,
        entries: [path],
        policy: { id: 'cff-web-strict' }
      });
      const finding = result.findings.find((item) => item.ruleId === 'H5A-DOC-005');
      outcomes.push({
        outcome: result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-DOC-005')
          ?.outcome,
        path: finding?.path,
        offset: finding?.range.start.offset ?? 0
      });
    }
    assert.deepEqual(
      outcomes.map(({ outcome }) => outcome),
      ['failed', 'failed', 'failed']
    );
    assert.deepEqual(
      outcomes.map(({ path }) => path),
      ['case-0.html', 'case-1.html', 'case-2.html']
    );
    assert.ok(outcomes.every(({ offset }) => offset > 0));
  });
});

void test('invalid global attribute values fail the frozen HTML grammar', async () => {
  await withFixture(async (root) => {
    const cases = ['dir="banana"', 'tabindex="wat"', 'draggable="maybe"'];
    const outcomes: Array<string | undefined> = [];
    for (const [index, attribute] of cases.entries()) {
      const path = `global-${index}.html`;
      await write(root, path, nativeDocument(`<div ${attribute}>Invalid global value</div>`));
      const result = await analyze({
        root,
        entries: [path],
        policy: { id: 'cff-web-strict' }
      });
      outcomes.push(
        result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-DOC-005')?.outcome
      );
    }
    assert.deepEqual(outcomes, ['failed', 'failed', 'failed']);
  });
});

void test('entry order cannot change the canonical result or receipt digest', async () => {
  await withFixture(async (root) => {
    await write(root, 'a.html', nativeDocument('<p>Document A.</p>'));
    await write(root, 'b.html', nativeDocument('<p>Document B.</p>'));
    const forward = await analyze({
      root,
      entries: ['a.html', 'b.html'],
      policy: { id: 'cff-web-strict' }
    });
    const reversed = await analyze({
      root,
      entries: ['b.html', 'a.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(canonicalJson(forward), canonicalJson(reversed));
    assert.deepEqual(forward.receipt.resultDigest, reversed.receipt.resultDigest);
    assert.deepEqual(forward.receipt.findingsDigest, reversed.receipt.findingsDigest);
  });
});

void test('adjacent unstyled navigation targets cannot silently pass target-size policy', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<nav aria-label="Related"><a href="#first">First</a><a href="#second">Second</a></nav>' +
          '<section id="first"><h2>First</h2></section><section id="second"><h2>Second</h2></section>'
      )
    );
    const result = await analyze(requestFor(root));
    const targetSize = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-005');
    assert.equal(targetSize?.outcome, 'cantTell');
    assert.equal(result.verdict, 'Inconclusive');
  });
});

void test('a substring class-selector match cannot prove target size', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<style>.one { min-width: 24px; min-height: 24px }</style>' +
          '<button type="button" class="on">Run</button>'
      )
    );
    const result = await analyze(requestFor(root));
    const targetSize = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-005');
    assert.notEqual(targetSize?.outcome, 'passed');
  });
});

void test('remote CSS dependency findings and SARIF locations identify the stylesheet', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CSS evidence</title>
<link rel="stylesheet" href="styles/site.css"></head><body>
<a href="#main">Skip to primary content</a><main id="main"><h1>CSS evidence</h1></main>
</body></html>`
    );
    await write(
      root,
      'styles/site.css',
      '@import "https://example.invalid/import.css";\n' +
        '.hero { background-image: url("https://example.invalid/hero.png") }\n'
    );
    const result = await analyze(requestFor(root));
    const findings = result.findings.filter((finding) => finding.ruleId === 'H5A-SAFE-001');
    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map((finding) => finding.path),
      ['styles/site.css', 'styles/site.css']
    );

    const sarif = toSarif(result) as {
      readonly runs: ReadonlyArray<{
        readonly results: ReadonlyArray<{
          readonly ruleId: string;
          readonly locations: ReadonlyArray<{
            readonly physicalLocation: { readonly artifactLocation: { readonly uri: string } };
          }>;
        }>;
      }>;
    };
    assert.deepEqual(
      sarif.runs[0]?.results
        .filter((entry) => entry.ruleId === 'H5A-SAFE-001')
        .map((entry) => entry.locations[0]?.physicalLocation.artifactLocation.uri),
      ['styles/site.css', 'styles/site.css']
    );
  });
});

void test('remote object, embed, submit, and area destinations remain blocking safety evidence', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<object data="https://example.invalid/object.bin"></object>' +
          '<embed src="https://example.invalid/embed.bin">' +
          '<input type="image" src="https://example.invalid/image-submit.png" alt="Image submit">' +
          '<form action=""><button type="submit" formaction="https://example.invalid/submit">Send</button></form>' +
          '<map name="routes"><area href="https://example.invalid/details" target="_blank" alt="Details"></map>'
      )
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-001')?.outcome,
      'failed'
    );
    assert.deepEqual(
      result.findings
        .filter((finding) => finding.ruleId === 'H5A-SAFE-001')
        .map((finding) => finding.observed)
        .sort(),
      [
        'https://example.invalid/embed.bin',
        'https://example.invalid/image-submit.png',
        'https://example.invalid/object.bin'
      ]
    );
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-003')?.outcome,
      'failed'
    );
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-004')?.outcome,
      'failed'
    );
  });
});

void test('a remote base URL makes a relative runtime script remote evidence', async () => {
  await withFixture(async (root) => {
    await write(root, 'app.js', 'export const localLookingName = true;');
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Remote base</title>' +
        '<base href="https://evil.example/"><script src="app.js" defer></script></head><body>' +
        '<a href="#main">Skip to primary content</a>' +
        '<main id="main"><h1>Remote base</h1></main></body></html>'
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-001')?.outcome,
      'failed'
    );
    assert.ok(result.findings.some((finding) => finding.ruleId === 'H5A-SAFE-001'));
  });
});

void test('a remote base URL makes an allowlisted root-relative form action remote', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Remote form base</title>' +
        '<base href="https://evil.example/"></head><body>' +
        '<a href="#main">Skip to primary content</a><main id="main"><h1>Remote form base</h1>' +
        '<form action="/search"><button type="submit">Search</button></form>' +
        '</main></body></html>'
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-004')?.outcome,
      'failed'
    );
    assert.ok(result.findings.some((finding) => finding.ruleId === 'H5A-SAFE-004'));
  });
});

void test('remote runtime URLs inside iframe srcdoc cannot be treated as complete-safe evidence', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<iframe title="Embedded preview" ' +
          'srcdoc="<img src=&quot;https://evil.example/srcdoc.png&quot; alt=&quot;&quot;>"></iframe>'
      )
    );
    const result = await analyze(requestFor(root));
    const evaluation = result.evaluations.find((item) => item.ruleId === 'H5A-SAFE-001');
    assert.ok(
      evaluation?.outcome === 'failed' || evaluation?.outcome === 'cantTell',
      `SAFE001 returned ${evaluation?.outcome ?? '(missing)'}`
    );
    const evidence = result.findings.find((finding) => finding.ruleId === 'H5A-SAFE-001');
    assert.equal(evidence?.path, 'index.html');
    assert.ok((evidence?.range.start.offset ?? 0) > 0);
    assert.ok((evidence?.range.end.offset ?? 0) > (evidence?.range.start.offset ?? 0));
  });
});

void test('refresh, responsive preload, SVG, and embedded-data runtime URLs stay offline evidence', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'refresh.html',
      '<!doctype html><html lang="en"><head><title>Remote refresh</title>' +
        '<meta http-equiv="refresh" content="0;url=https://evil.example/refresh"></head><body>' +
        '<a href="#main">Skip</a><main id="main">Primary</main></body></html>'
    );
    const refresh = await analyze({
      root,
      entries: ['refresh.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(
      root,
      'svg.html',
      nativeDocument(
        '<svg aria-label="Remote SVG resources">' +
          '<image href="https://evil.example/image.svg"></image>' +
          '<use href="https://evil.example/icons.svg#mark"></use>' +
          '<filter id="remote-filter"><feImage href="https://evil.example/filter.png"></feImage></filter>' +
          '</svg>'
      )
    );
    const svg = await analyze({
      root,
      entries: ['svg.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(root, 'local.png', 'local image bytes');
    await write(
      root,
      'preload.html',
      '<!doctype html><html lang="en"><head><title>Responsive preload</title>' +
        '<link rel="preload" as="image" href="local.png" ' +
        'imagesrcset="https://evil.example/preload.png 1x"></head><body>' +
        '<a href="#main">Skip</a><main id="main">Primary</main></body></html>'
    );
    const preload = await analyze({
      root,
      entries: ['preload.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(
      root,
      'data-frame.html',
      nativeDocument(
        '<iframe title="Embedded data document" ' +
          'src="data:text/html,%3Cimg%20src%3D%22https%3A%2F%2Fevil.example%2Fnested.png%22%3E"></iframe>'
      )
    );
    const dataFrame = await analyze({
      root,
      entries: ['data-frame.html'],
      policy: { id: 'cff-web-strict' }
    });

    const outcomes = {
      refresh: refresh.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-001')
        ?.outcome,
      svg: svg.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-001')?.outcome,
      preload: preload.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-001')
        ?.outcome,
      dataFrame: dataFrame.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-001')
        ?.outcome
    };
    assert.deepEqual(
      { refresh: outcomes.refresh, svg: outcomes.svg, preload: outcomes.preload },
      { refresh: 'failed', svg: 'failed', preload: 'failed' }
    );
    assert.ok(
      outcomes.dataFrame === 'failed' || outcomes.dataFrame === 'cantTell',
      `SAFE001 returned ${outcomes.dataFrame ?? '(missing)'} for embedded data HTML`
    );
    assert.deepEqual(
      svg.findings
        .filter((finding) => finding.ruleId === 'H5A-SAFE-001')
        .map((finding) => finding.observed)
        .sort(),
      [
        'https://evil.example/filter.png',
        'https://evil.example/icons.svg#mark',
        'https://evil.example/image.svg'
      ]
    );
    for (const [path, result] of [
      ['refresh.html', refresh],
      ['svg.html', svg],
      ['preload.html', preload],
      ['data-frame.html', dataFrame]
    ] as const) {
      const finding = result.findings.find((item) => item.ruleId === 'H5A-SAFE-001');
      assert.equal(finding?.path, path);
      assert.ok((finding?.range.start.offset ?? 0) > 0);
    }
  });
});

void test('remote metadata link relations are not runtime dependencies', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Metadata links</title>' +
        '<link rel="canonical" href="https://docs.example/page">' +
        '<link rel="license" href="https://docs.example/license"></head><body>' +
        '<a href="#main">Skip to primary content</a>' +
        '<main id="main"><h1>Metadata links</h1></main></body></html>'
    );
    const result = await analyze(requestFor(root));
    assert.notEqual(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-001')?.outcome,
      'failed'
    );
    assert.equal(
      result.findings.some((finding) => finding.ruleId === 'H5A-SAFE-001'),
      false
    );
  });
});

void test('remote fetched link relations remain runtime dependency findings', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Fetched links</title>' +
        '<link rel="stylesheet" href="https://cdn.example/site.css">' +
        '<link rel="preload" href="https://cdn.example/font.woff2" as="font">' +
        '<link rel="modulepreload" href="https://cdn.example/app.js">' +
        '<link rel="preconnect" href="https://api.example"></head><body>' +
        '<a href="#main">Skip to primary content</a>' +
        '<main id="main"><h1>Fetched links</h1></main></body></html>'
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-001')?.outcome,
      'failed'
    );
    assert.deepEqual(
      result.findings
        .filter((finding) => finding.ruleId === 'H5A-SAFE-001')
        .map((finding) => finding.observed)
        .sort(),
      [
        'https://api.example',
        'https://cdn.example/app.js',
        'https://cdn.example/font.woff2',
        'https://cdn.example/site.css'
      ]
    );
  });
});

void test('a CSP cannot authorize a remote connection source', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Unsafe CSP</title>' +
        '<meta http-equiv="Content-Security-Policy" ' +
        'content="default-src \'self\'; connect-src https://evil.example"></head><body>' +
        '<a href="#main">Skip to primary content</a>' +
        '<main id="main"><h1>Unsafe CSP</h1></main></body></html>'
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-006')?.outcome,
      'failed'
    );
    assert.ok(result.findings.some((finding) => finding.ruleId === 'H5A-SAFE-006'));
  });
});

void test('style attributes participate in safety, CSS, theme, and HTML source evidence', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<p style="background-image:url(https://evil.example/background.png);' +
          'color:#aaa;background-color:#fff;margin-left:1rem">Inline style evidence</p>'
      )
    );
    await write(
      root,
      'manifest.json',
      JSON.stringify({
        schemaVersion: 'cff.page-manifest.v1',
        entries: ['index.html'],
        pages: { 'index.html': 'documentation' },
        requiredTheme: 'cff-evidence/1.0.0',
        html5AssayPolicy: 'cff-web-strict'
      })
    );
    const result = await analyze({
      root,
      entries: [],
      manifest: 'manifest.json',
      policy: { id: 'cff-web-strict' }
    });
    const remote = result.findings.find(
      (finding) =>
        finding.ruleId === 'H5A-SAFE-001' &&
        finding.observed === 'https://evil.example/background.png'
    );
    assert.equal(remote?.path, 'index.html');
    assert.ok((remote?.range.start.offset ?? 0) > 0);
    assert.ok((remote?.range.end.offset ?? 0) > (remote?.range.start.offset ?? 0));
    for (const ruleId of ['H5A-CSS-003', 'H5A-CSS-009', 'H5A-THEME-001']) {
      assert.equal(
        result.evaluations.find((evaluation) => evaluation.ruleId === ruleId)?.outcome,
        'failed',
        ruleId
      );
    }
  });
});

void test('a transparent border cannot replace a removed focus outline', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<style>button:focus { outline: none; border: 1px solid transparent }</style>' +
          '<button type="button">Run</button>'
      )
    );
    const result = await analyze(requestFor(root));
    const focus = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-001');
    assert.equal(focus?.outcome, 'failed');
    assert.ok(result.findings.some((finding) => finding.ruleId === 'H5A-CSS-001'));
    assert.equal(result.verdict, 'Fail');
  });
});

void test('an unresolved focus-border color cannot prove a visible replacement', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<style>button:focus { outline: none; border: 1px solid var(--runtime-focus) }</style>' +
          '<button type="button">Run</button>'
      )
    );
    const result = await analyze(requestFor(root));
    const focus = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-001');
    assert.equal(focus?.outcome, 'cantTell');
    assert.equal(result.verdict, 'Inconclusive');
  });
});

void test('generic reflow-safe CSS cannot hide independently unsafe width evidence', async () => {
  await withFixture(async (root) => {
    const cases = [
      '<style>main { max-width: 100%; overflow-wrap: anywhere }</style>' +
        '<img src="hero.png" alt="" width="1000">',
      '<style>main { max-width: 100%; overflow-wrap: anywhere } pre { white-space: pre }</style>' +
        '<pre>Long unbroken preformatted content</pre>'
    ];
    await write(root, 'hero.png', 'local image bytes');
    for (const [index, body] of cases.entries()) {
      await write(root, `case-${index}.html`, nativeDocument(body));
      const result = await analyze({
        root,
        entries: [`case-${index}.html`],
        policy: { id: 'cff-web-strict' }
      });
      const reflow = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-008');
      assert.notEqual(reflow?.outcome, 'passed', `case ${index}`);
    }
  });
});

void test('split contrast declarations cannot be discarded as inapplicable or passing', async () => {
  await withFixture(async (root) => {
    const cases = [
      {
        ruleId: 'H5A-CSS-003',
        body:
          '<style>body { background: #777 } p { color: #777 }</style>' + '<p>Low-contrast text</p>'
      },
      {
        ruleId: 'H5A-CSS-004',
        body:
          '<style>body { background: #777 } button { border: 2px solid #777 }</style>' +
          '<button type="button">Low-contrast edge</button>'
      }
    ] as const;
    for (const [index, fixture] of cases.entries()) {
      await write(root, `case-${index}.html`, nativeDocument(fixture.body));
      const result = await analyze({
        root,
        entries: [`case-${index}.html`],
        policy: { id: 'cff-web-strict' }
      });
      const outcome = result.evaluations.find(
        (evaluation) => evaluation.ruleId === fixture.ruleId
      )?.outcome;
      assert.ok(
        outcome === 'failed' || outcome === 'cantTell',
        `${fixture.ruleId} returned ${outcome ?? '(missing)'}`
      );
    }
  });
});

void test('obsolete align attributes fail the no-obsolete-features rule', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument('<p align="center">Legacy alignment</p>'));
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-DOC-006')?.outcome,
      'failed'
    );
    assert.ok(result.findings.some((finding) => finding.ruleId === 'H5A-DOC-006'));
  });
});

void test('descendant link text does not label repeated navigation landmarks', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<nav><a href="/first">First destination</a></nav>' +
          '<nav><a href="/second">Second destination</a></nav>'
      )
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SEM-007')?.outcome,
      'failed'
    );
    assert.ok(result.findings.some((finding) => finding.ruleId === 'H5A-SEM-007'));
  });
});

void test('a statically CSS-hidden sibling main does not create a second visible landmark', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<style>.secondary { display: none }</style>' +
          '<main class="secondary"><h2>Inactive content</h2></main>'
      )
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SEM-001')?.outcome,
      'passed'
    );
  });
});

void test('an inline hidden main does not hide its visible same-tag sibling', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Scoped visibility</title></head><body>' +
        '<a href="#primary">Skip to primary content</a>' +
        '<main style="display:none"><h1>Inactive content</h1></main>' +
        '<main id="primary"><h1>Primary content</h1></main>' +
        '</body></html>'
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SEM-001')?.outcome,
      'passed'
    );
  });
});

void test('conditional or overridden display none cannot prove a main is hidden', async () => {
  await withFixture(async (root) => {
    const cases = [
      '<style>@media print { .auxiliary { display:none } }</style>',
      '<style>.auxiliary { display:none }.auxiliary { display:block }</style>'
    ];
    const outcomes: Array<string | undefined> = [];
    for (const [index, css] of cases.entries()) {
      await write(
        root,
        `case-${index}.html`,
        '<!doctype html><html lang="en"><head><title>Visibility cascade</title>' +
          css +
          '</head><body><a href="#primary">Skip to primary content</a>' +
          '<main class="auxiliary"><h1>Auxiliary content</h1></main>' +
          '<main id="primary"><h1>Primary content</h1></main></body></html>'
      );
      const result = await analyze({
        root,
        entries: [`case-${index}.html`],
        policy: { id: 'cff-web-strict' }
      });
      outcomes.push(
        result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SEM-001')?.outcome
      );
    }
    assert.ok(outcomes.every((outcome) => outcome === 'failed' || outcome === 'cantTell'));
  });
});

void test('same-page jump wording can satisfy the primary-content bypass rule', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Jump link</title></head><body>' +
        '<a href="#main">Jump to content</a>' +
        '<main id="main"><h1>Primary content</h1></main></body></html>'
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SEM-002')?.outcome,
      'passed'
    );
  });
});

void test('ARIA numeric properties reject non-numeric tokens', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument('<div role="heading" aria-level="banana">Heading</div>')
    );
    const result = await analyze(requestFor(root));
    const aria = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-A11Y-004');
    assert.equal(aria?.outcome, 'failed');
    assert.ok(
      result.findings.some(
        (finding) => finding.ruleId === 'H5A-A11Y-004' && finding.observed === 'banana'
      )
    );
    assert.equal(result.verdict, 'Fail');
  });
});

void test('ARIA host constraints, required properties, and owned roles are enforced', async () => {
  await withFixture(async (root) => {
    const cases = [
      '<button type="button" aria-level="2">Wrong host</button>',
      '<div role="heading">Heading without a level</div>',
      '<div role="listbox" aria-label="Choices"></div>'
    ];
    for (const [index, body] of cases.entries()) {
      await write(root, `case-${index}.html`, nativeDocument(body));
      const result = await analyze({
        root,
        entries: [`case-${index}.html`],
        policy: { id: 'cff-web-strict' }
      });
      const aria = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-A11Y-004');
      assert.equal(aria?.outcome, 'failed', `case ${index}`);
      assert.ok(
        result.findings.some((finding) => finding.ruleId === 'H5A-A11Y-004'),
        `case ${index}`
      );
    }
  });
});

void test('image inputs require alt text', async () => {
  await withFixture(async (root) => {
    await write(root, 'missing-alt.html', nativeDocument('<input type="image" src="submit.png">'));
    await write(root, 'submit.png', 'local image input bytes');
    const missingAlt = await analyze({
      root,
      entries: ['missing-alt.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(
      missingAlt.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-A11Y-001')?.outcome,
      'failed'
    );
  });
});

void test('title can provide the fallback accessible name for a text input', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'title-name.html',
      nativeDocument('<input type="text" title="Search terms">')
    );
    const titleName = await analyze({
      root,
      entries: ['title-name.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(
      titleName.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-A11Y-002')?.outcome,
      'passed'
    );
  });
});

void test('inline styles remain scoped to their exact same-tag control or image', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'controls.html',
      nativeDocument(
        '<button type="button" style="min-width:24px;min-height:24px">Sized</button>' +
          '<button type="button">Unknown size</button>'
      )
    );
    const controls = await analyze({
      root,
      entries: ['controls.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(
      controls.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-005')?.outcome,
      'cantTell'
    );

    await write(root, 'pixel.png', 'local image bytes');
    await write(
      root,
      'images.html',
      nativeDocument(
        '<img src="pixel.png" alt="" style="aspect-ratio:1/1">' + '<img src="pixel.png" alt="">'
      )
    );
    const images = await analyze({
      root,
      entries: ['images.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(
      images.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-PERF-002')?.outcome,
      'failed'
    );
  });
});

void test('ancestor-qualified selector evidence cannot leak to same-tag siblings', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'controls.html',
      nativeDocument(
        '<style>.dialog button { min-width:24px; min-height:24px }</style>' +
          '<section class="dialog"><button type="button">Dialog action</button></section>' +
          '<button type="button">Outside action</button>'
      )
    );
    const controls = await analyze({
      root,
      entries: ['controls.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(
      root,
      'mains.html',
      '<!doctype html><html lang="en"><head><title>Scoped main</title>' +
        '<style>.dialog main { display:none }</style></head><body>' +
        '<a href="#primary">Skip to primary content</a>' +
        '<section class="dialog"><main><h1>Dialog content</h1></main></section>' +
        '<main id="primary"><h1>Primary content</h1></main></body></html>'
    );
    const mains = await analyze({
      root,
      entries: ['mains.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(root, 'pixel.png', 'local image bytes');
    await write(
      root,
      'images.html',
      nativeDocument(
        '<style>.card img { aspect-ratio:1/1 }</style>' +
          '<section class="card"><img src="pixel.png" alt=""></section>' +
          '<img src="pixel.png" alt="">'
      )
    );
    const images = await analyze({
      root,
      entries: ['images.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.deepEqual(
      {
        targetSize: controls.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-005')
          ?.outcome,
        mainLandmark: mains.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SEM-001')
          ?.outcome,
        imageAspectRatio: images.evaluations.find(
          (evaluation) => evaluation.ruleId === 'H5A-PERF-002'
        )?.outcome
      },
      {
        targetSize: 'cantTell',
        mainLandmark: 'passed',
        imageAspectRatio: 'failed'
      }
    );
  });
});

void test('a later cascade override invalidates earlier target-size proof', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<style>button { min-width:24px; min-height:24px } button { min-width:auto }</style>' +
          '<button type="button">Overridden size</button>'
      )
    );
    const result = await analyze(requestFor(root));
    assert.equal(
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-005')?.outcome,
      'cantTell'
    );
  });
});

void test('conditional CSS and CFF page kind cannot overstate target or reflow proof', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'conditional-target.html',
      nativeDocument(
        '<style>@media(min-width:1000px){button{min-width:24px;min-height:24px}}</style>' +
          '<button type="button">Only conditionally sized</button>'
      )
    );
    const conditionalTarget = await analyze({
      root,
      entries: ['conditional-target.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(
      root,
      'conditional-reflow.html',
      nativeDocument(
        '<style>main{max-width:100%}@media(min-width:1000px){main{overflow-wrap:anywhere}}</style>' +
          '<p>Ordinary content.</p>'
      )
    );
    const conditionalReflow = await analyze({
      root,
      entries: ['conditional-reflow.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(
      root,
      'cff.html',
      '<!doctype html><html lang="en"><head><title>CFF target</title>' +
        '<style>button{min-width:24px;min-height:24px}</style></head><body>' +
        '<header>HTML5Assay 0.1.0 Specified static source evidence authority</header>' +
        '<nav>Primary</nav><main><button type="button">Action</button></main>' +
        '<footer>Footer</footer></body></html>'
    );
    await write(
      root,
      'manifest.json',
      JSON.stringify({
        schemaVersion: 'cff.page-manifest.v1',
        pages: { 'cff.html': 'overview' },
        requiredTheme: 'cff-evidence/1.0.0'
      })
    );
    const cff = await analyze({
      root,
      entries: ['cff.html'],
      manifest: 'manifest.json',
      policy: { id: 'cff-web-strict' }
    });

    assert.deepEqual(
      {
        conditionalTarget: conditionalTarget.evaluations.find(
          (evaluation) => evaluation.ruleId === 'H5A-CSS-005'
        )?.outcome,
        conditionalReflow: conditionalReflow.evaluations.find(
          (evaluation) => evaluation.ruleId === 'H5A-CSS-008'
        )?.outcome,
        cffTarget: cff.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-005')
          ?.outcome
      },
      {
        conditionalTarget: 'cantTell',
        conditionalReflow: 'cantTell',
        cffTarget: 'failed'
      }
    );
  });
});

void test('later cascade values control focus, contrast, motion, reflow, and image proof', async () => {
  await withFixture(async (root) => {
    await write(root, 'go.png', 'local image bytes');
    const cases = [
      {
        name: 'focus',
        ruleId: 'H5A-CSS-001',
        expected: 'failed',
        body:
          '<style>:focus{outline:none;border:2px solid black}:focus{border:none}</style>' +
          '<button type="button">Go</button>'
      },
      {
        name: 'textContrast',
        ruleId: 'H5A-CSS-003',
        expected: 'failed',
        body: '<style>p{color:black;background:white}p{color:#aaa}</style><p>Low contrast</p>'
      },
      {
        name: 'controlContrast',
        ruleId: 'H5A-CSS-004',
        expected: 'failed',
        body:
          '<style>button{border:2px solid black;background:white}' +
          'button{border-color:#ddd}</style><button type="button">Go</button>'
      },
      {
        name: 'reducedMotion',
        ruleId: 'H5A-CSS-006',
        expected: 'failed',
        body:
          '<style>.x{animation:pulse 1s}@media(prefers-reduced-motion:reduce){' +
          '.x{animation:none}.x{animation:pulse 1s}}</style><div class="x">Motion</div>'
      },
      {
        name: 'reflow',
        ruleId: 'H5A-CSS-008',
        expected: 'cantTell',
        body:
          '<style>main{max-width:100%;overflow-wrap:anywhere}' +
          'main{overflow-wrap:normal}</style><p>Content</p>'
      },
      {
        name: 'aspectRatio',
        ruleId: 'H5A-PERF-002',
        body:
          '<style>img{aspect-ratio:1/1}img{aspect-ratio:auto}</style>' + '<img src="go.png" alt="">'
      }
    ] as const;
    const outcomes: Record<string, string | undefined> = {};
    for (const [index, fixture] of cases.entries()) {
      const path = `cascade-${index}.html`;
      await write(root, path, nativeDocument(fixture.body));
      const result = await analyze({
        root,
        entries: [path],
        policy: { id: 'cff-web-strict' }
      });
      outcomes[fixture.name] = result.evaluations.find(
        (evaluation) => evaluation.ruleId === fixture.ruleId
      )?.outcome;
    }
    assert.deepEqual(
      {
        focus: outcomes.focus,
        textContrast: outcomes.textContrast,
        controlContrast: outcomes.controlContrast,
        reducedMotion: outcomes.reducedMotion,
        reflow: outcomes.reflow,
        aspectRatioPasses: outcomes.aspectRatio === 'passed'
      },
      {
        focus: 'failed',
        textContrast: 'failed',
        controlContrast: 'failed',
        reducedMotion: 'failed',
        reflow: 'cantTell',
        aspectRatioPasses: false
      }
    );
  });
});

void test('CSS source order includes mixed link-style nodes and local imports', async () => {
  await withFixture(async (root) => {
    await write(root, 'safe.css', 'p{color:black;background:white}');
    await write(root, 'bad.css', 'p{color:#aaa}');
    await write(
      root,
      'link-then-style.html',
      '<!doctype html><html lang="en"><head><title>Link then style</title>' +
        '<link rel="stylesheet" href="safe.css"><style>p{color:#aaa}</style></head><body>' +
        '<a href="#main">Skip</a><main id="main"><p>Low contrast</p></main></body></html>'
    );
    await write(
      root,
      'style-then-link.html',
      '<!doctype html><html lang="en"><head><title>Style then link</title>' +
        '<style>p{color:black;background:white}</style>' +
        '<link rel="stylesheet" href="bad.css"></head><body>' +
        '<a href="#main">Skip</a><main id="main"><p>Low contrast</p></main></body></html>'
    );
    const linkThenStyle = await analyze({
      root,
      entries: ['link-then-style.html'],
      policy: { id: 'cff-web-strict' }
    });
    const styleThenLink = await analyze({
      root,
      entries: ['style-then-link.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(root, 'imported-good.css', 'p{color:black;background:white}');
    await write(root, 'importer-bad.css', '@import "imported-good.css";p{color:#aaa}');
    await write(root, 'imported-bad.css', 'p{color:#aaa;background:white}');
    await write(root, 'importer-good.css', '@import "imported-bad.css";p{color:black}');
    await write(
      root,
      'import-bad.html',
      nativeDocument('<link rel="stylesheet" href="importer-bad.css"><p>Low contrast</p>')
    );
    await write(
      root,
      'import-good.html',
      nativeDocument('<link rel="stylesheet" href="importer-good.css"><p>Good contrast</p>')
    );
    const importBad = await analyze({
      root,
      entries: ['import-bad.html'],
      policy: { id: 'cff-web-strict' }
    });
    const importGood = await analyze({
      root,
      entries: ['import-good.html'],
      policy: { id: 'cff-web-strict' }
    });
    const contrast = (result: AnalyzeResult): string | undefined =>
      result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-CSS-003')?.outcome;
    assert.deepEqual(
      {
        linkThenStyle: contrast(linkThenStyle),
        styleThenLink: contrast(styleThenLink),
        importBad: contrast(importBad),
        importGood: contrast(importGood)
      },
      {
        linkThenStyle: 'failed',
        styleThenLink: 'failed',
        importBad: 'failed',
        importGood: 'passed'
      }
    );
  });
});

void test('ARIA tokens, native names, hidden text, and role conflicts use exact semantics', async () => {
  await withFixture(async (root) => {
    await write(root, 'go.png', 'local image bytes');
    const cases = [
      {
        name: 'aria-current',
        ruleId: 'H5A-A11Y-004',
        body: '<a href="#main" aria-current="banana">Current page</a>',
        expected: 'failed'
      },
      {
        name: 'aria-haspopup',
        ruleId: 'H5A-A11Y-004',
        body: '<button type="button" aria-haspopup="banana">Menu</button>',
        expected: 'failed'
      },
      {
        name: 'aria-autocomplete',
        ruleId: 'H5A-A11Y-004',
        body:
          '<input role="combobox" aria-label="Choose" aria-autocomplete="banana" ' +
          'aria-expanded="false" aria-controls="choices">' +
          '<div id="choices" role="listbox"><div role="option">One</div></div>',
        expected: 'failed'
      },
      {
        name: 'image-alt-name',
        ruleId: 'H5A-A11Y-002',
        body: '<input type="image" src="go.png" alt="Submit">',
        expected: 'passed'
      },
      {
        name: 'submit-value-name',
        ruleId: 'H5A-A11Y-002',
        body: '<input type="submit" value="Submit">',
        expected: 'passed'
      },
      {
        name: 'button-hidden-text',
        ruleId: 'H5A-A11Y-003',
        body: '<button type="button"><span aria-hidden="true">Icon</span></button>',
        expected: 'failed'
      },
      {
        name: 'button-title',
        ruleId: 'H5A-A11Y-003',
        body: '<button type="button" title="Submit"></button>',
        expected: 'passed'
      },
      {
        name: 'native-role-conflict',
        ruleId: 'H5A-A11Y-005',
        body: '<input type="checkbox" role="textbox" aria-label="Bad role">',
        expected: 'failed'
      }
    ] as const;
    const outcomes: Record<string, string | undefined> = {};
    const observations: Record<string, string | undefined> = {};
    for (const [index, fixture] of cases.entries()) {
      const path = `aria-${index}.html`;
      await write(root, path, nativeDocument(fixture.body));
      const result = await analyze({
        root,
        entries: [path],
        policy: { id: 'cff-web-strict' }
      });
      outcomes[fixture.name] = result.evaluations.find(
        (evaluation) => evaluation.ruleId === fixture.ruleId
      )?.outcome;
      observations[fixture.name] = result.findings.find(
        (finding) => finding.ruleId === fixture.ruleId
      )?.observed;
    }
    assert.deepEqual(
      outcomes,
      Object.fromEntries(cases.map(({ name, expected }) => [name, expected]))
    );
    assert.match(observations['aria-current'] ?? '', /aria-current/iu);
    assert.match(observations['aria-haspopup'] ?? '', /aria-haspopup/iu);
    assert.match(observations['aria-autocomplete'] ?? '', /aria-autocomplete/iu);
  });
});

void test('skip-link and structural main visibility honor exact element scope', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'hidden-skip.html',
      '<!doctype html><html lang="en"><head><title>Hidden skip</title></head><body>' +
        '<a hidden href="#primary">Skip</a><main id="primary">Primary</main></body></html>'
    );
    const hiddenSkip = await analyze({
      root,
      entries: ['hidden-skip.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(
      root,
      'child-main.html',
      '<!doctype html><html lang="en"><head><title>Child selector</title>' +
        '<style>.aux>main{display:none}</style></head><body>' +
        '<a href="#primary">Skip</a><main id="primary">Primary</main>' +
        '<div class="aux"><main>Hidden alternative</main></div></body></html>'
    );
    const childMain = await analyze({
      root,
      entries: ['child-main.html'],
      policy: { id: 'cff-web-strict' }
    });

    assert.deepEqual(
      {
        hiddenSkip: hiddenSkip.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SEM-002')
          ?.outcome,
        childMain: childMain.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SEM-001')
          ?.outcome
      },
      { hiddenSkip: 'failed', childMain: 'passed' }
    );
  });
});

void test('invalid intrinsic dimensions and remote font sources are exact performance failures', async () => {
  await withFixture(async (root) => {
    await write(root, 'go.png', 'local image bytes');
    await write(
      root,
      'image.html',
      nativeDocument('<img src="go.png" alt="" width="banana" height="0">')
    );
    const image = await analyze({
      root,
      entries: ['image.html'],
      policy: { id: 'cff-web-strict' }
    });

    await write(
      root,
      'font.html',
      nativeDocument(
        '<style>@font-face{font-family:Remote;src:url(https://evil.example/font.woff2)}' +
          'body{font-family:Remote,sans-serif}</style><p>Remote font.</p>'
      )
    );
    const font = await analyze({
      root,
      entries: ['font.html'],
      policy: { id: 'cff-web-strict' }
    });

    assert.deepEqual(
      {
        dimensions: image.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-PERF-002')
          ?.outcome,
        remoteFont: font.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-PERF-004')
          ?.outcome
      },
      { dimensions: 'failed', remoteFont: 'failed' }
    );
  });
});

void test('page-title uniqueness is enforced across analyzed entries', async () => {
  await withFixture(async (root) => {
    const page =
      '<!doctype html><html lang="en"><head><title>Same title</title></head><body>' +
      '<a href="#primary">Skip</a><main id="primary">Primary</main></body></html>';
    await write(root, 'a.html', page);
    await write(root, 'b.html', page);
    const result = await analyze({
      root,
      entries: ['a.html', 'b.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.deepEqual(
      result.evaluations
        .filter((evaluation) => evaluation.ruleId === 'H5A-DOC-003')
        .map((evaluation) => evaluation.outcome),
      ['failed', 'failed']
    );
  });
});

void test('content terminology is not misclassified as a tracking reference', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument(
        '<section aria-label="Analytics documentation"><h2>Analytics policy</h2></section>'
      )
    );
    const result = await analyze(requestFor(root));
    const tracking = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-005');
    assert.notEqual(tracking?.outcome, 'failed');
    assert.equal(
      result.findings.some((finding) => finding.ruleId === 'H5A-SAFE-005'),
      false
    );
  });
});

void test('a benign pixel-art filename is not tracking evidence', async () => {
  await withFixture(async (root) => {
    await write(root, 'pixel-art.png', 'local illustration bytes');
    await write(
      root,
      'index.html',
      nativeDocument(
        '<img src="pixel-art.png" alt="Pixel-art illustration" width="32" height="32">'
      )
    );
    const result = await analyze(requestFor(root));
    const tracking = result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-005');
    assert.notEqual(tracking?.outcome, 'failed');
    assert.equal(
      result.findings.some((finding) => finding.ruleId === 'H5A-SAFE-005'),
      false
    );
  });
});

void test('reporting attributes fail tracking policy without relying on URL keywords', async () => {
  await withFixture(async (root) => {
    await write(root, 'pixel.png', 'local pixel bytes');
    const cases = [
      '<a href="/docs" ping="/report">Documentation</a>',
      '<img src="pixel.png" alt="Example" attributionsrc="/report">',
      '<img src="pixel.png" alt="Example" browsingtopics>'
    ];
    const outcomes: Array<string | undefined> = [];
    for (const [index, body] of cases.entries()) {
      await write(root, `case-${index}.html`, nativeDocument(body));
      const result = await analyze({
        root,
        entries: [`case-${index}.html`],
        policy: { id: 'cff-web-strict' }
      });
      outcomes.push(
        result.evaluations.find((evaluation) => evaluation.ruleId === 'H5A-SAFE-005')?.outcome
      );
    }
    assert.deepEqual(outcomes, ['failed', 'failed', 'failed']);
  });
});

void test('only current, attributable suppressions remove a blocking finding', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument('<button type="button" onclick="runLocalTask()">Run</button>')
    );
    const suppression = {
      ruleId: 'H5A-SAFE-002',
      path: 'index.html',
      owner: 'accessibility-review',
      reason: 'Temporary reviewed exception',
      expires: '2026-08-20'
    } as const;
    await write(
      root,
      'policy.json',
      JSON.stringify({
        ...strictPolicy,
        id: 'independent-suppression',
        suppressions: [suppression]
      })
    );
    const current = await analyze({
      root,
      entries: ['index.html'],
      policy: { id: 'independent-suppression', path: 'policy.json' }
    });
    const suppressed = current.findings.find((finding) => finding.ruleId === 'H5A-SAFE-002');
    assert.deepEqual(suppressed?.suppression, {
      suppressed: true,
      owner: suppression.owner,
      reason: suppression.reason,
      expires: suppression.expires
    });
    assert.notEqual(current.verdict, 'Fail');
    assert.equal(current.counts.blocking, 0);

    await write(
      root,
      'policy.json',
      JSON.stringify({
        ...strictPolicy,
        id: 'independent-suppression',
        suppressions: [{ ...suppression, expires: '2026-08-18' }]
      })
    );
    const expired = await analyze({
      root,
      entries: ['index.html'],
      policy: { id: 'independent-suppression', path: 'policy.json' }
    });
    const unsuppressed = expired.findings.find((finding) => finding.ruleId === 'H5A-SAFE-002');
    assert.equal(unsuppressed?.suppression, undefined);
    assert.equal(expired.verdict, 'Fail');
    assert.ok(expired.counts.blocking > 0);
  });
});

void test('finding truncation records the limit without concealing the full Fail verdict', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      '<html><head></head><body><script>bad()</script></body></html>'
    );
    await write(
      root,
      'policy.json',
      JSON.stringify({
        ...strictPolicy,
        id: 'independent-finding-limit',
        limits: { ...strictPolicy.limits, findings: 1 }
      })
    );
    const result = await analyze({
      root,
      entries: ['index.html'],
      policy: { id: 'independent-finding-limit', path: 'policy.json' }
    });
    assert.equal(result.verdict, 'Fail');
    assert.equal(result.findings.length, 1);
    assert.ok(result.counts.blocking > result.findings.length);
    assert.deepEqual(
      result.limits.map(({ id, limit }) => ({ id, limit })),
      [{ id: 'findings', limit: 1 }]
    );
    assert.deepEqual(result.receipt.limits, result.limits);
  });
});

void test('turning off a blocking rule remains explicit unknown evidence', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      nativeDocument('<button type="button" onclick="runLocalTask()">Run</button>')
    );
    await write(
      root,
      'policy.json',
      JSON.stringify({
        ...strictPolicy,
        id: 'independent-off-rule',
        levels: { 'H5A-SAFE-002': 'off' }
      })
    );
    const result = await analyze({
      root,
      entries: ['index.html'],
      policy: { id: 'independent-off-rule', path: 'policy.json' }
    });
    const inlineScript = result.evaluations.find(
      (evaluation) => evaluation.ruleId === 'H5A-SAFE-002'
    );
    assert.deepEqual(inlineScript, {
      ruleId: 'H5A-SAFE-002',
      ruleVersion: '1.0.0',
      path: 'index.html',
      outcome: 'untested',
      level: 'blocking',
      findingCount: 0
    });
    assert.equal(
      result.findings.some((finding) => finding.ruleId === 'H5A-SAFE-002'),
      false
    );
    assert.ok(result.counts.inconclusive > 0);
    assert.equal(result.verdict, 'Inconclusive');
  });
});

void test('public analyze converts setup failures into a total ToolFailure result', async () => {
  await withFixture(async (root) => {
    const result = await analyze({
      root: join(root, 'missing-root'),
      entries: ['index.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(result.verdict, 'ToolFailure');
    assert.deepEqual(
      result.toolFailures.map((failure) => failure.code),
      ['H5A-TOOL-SETUP']
    );
    assert.deepEqual(result.findings, []);
  });
});

void test('verdict priority is Fail over Inconclusive and ToolFailure over source findings', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument('<button type="button">Run</button>'));
    const incomplete = await analyze(requestFor(root));
    assert.equal(incomplete.verdict, 'Inconclusive');
    assert.ok(
      incomplete.evaluations.some(
        (evaluation) => evaluation.ruleId === 'H5A-CSS-005' && evaluation.outcome === 'cantTell'
      )
    );

    await write(
      root,
      'index.html',
      nativeDocument('<button type="button" onclick="runTask()">Run</button>')
    );
    const failed = await analyze(requestFor(root));
    assert.equal(failed.verdict, 'Fail');
    assert.ok(failed.findings.some((finding) => finding.ruleId === 'H5A-SAFE-002'));
    assert.ok(failed.counts.inconclusive > 0);

    await write(
      root,
      'index.html',
      nativeDocument(
        '<button type="button" onclick="runTask()">Run</button><link rel="stylesheet" href="bad.css">'
      )
    );
    await write(root, 'bad.css', '.broken { color: red;');
    const toolFailure = await analyze(requestFor(root));
    assert.equal(toolFailure.verdict, 'ToolFailure');
    assert.deepEqual(toolFailure.findings, []);
    assert.deepEqual(toolFailure.evaluations, []);
    assert.deepEqual(toolFailure.limits, []);
    assert.deepEqual(
      toolFailure.toolFailures.map((failure) => failure.code),
      ['H5A-PARSER-CSS']
    );
  });
});

void test('subject and manifest digests bind supplied bytes and manifest identity', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument());
    const first = await analyze(requestFor(root));
    await write(root, 'index.html', nativeDocument('<p>Changed bytes.</p>'));
    const second = await analyze(requestFor(root));
    assert.notEqual(first.subject.digest.value, second.subject.digest.value);
  });

  const manifestBytes = await readFile('playground/manifest.json', 'utf8');
  assert.ok(manifestBytes.includes('cff.page-manifest.v1'));
  const result = await analyze({
    root: process.cwd(),
    entries: [],
    manifest: 'playground/manifest.json',
    policy: { id: 'cff-web-strict' }
  });
  assert.notEqual(result.verdict, 'ToolFailure');
  assert.notEqual(result.receipt.manifestDigest, null);
  assert.ok(result.evaluations.every((evaluation) => evaluation.path === 'playground/index.html'));
});

void test('runtime manifest validation rejects fields excluded by the published schema', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument());
    const base = {
      schemaVersion: 'cff.page-manifest.v1',
      pages: { 'index.html': 'documentation' },
      requiredTheme: 'cff-evidence/1.0.0'
    } as const;
    const invalid = [
      { ...base, unexpectedField: true },
      { ...base, entries: 'index.html' },
      { ...base, localAssetRoots: [1] },
      {
        ...base,
        fragments: {
          'index.html': { contextElement: 'main', unexpectedField: true }
        }
      },
      {
        ...base,
        approvedSuppressions: [
          {
            ruleId: 'H5A-SAFE-002',
            owner: 'reviewer',
            reason: 'temporary',
            expires: '2026-08-20',
            unexpectedField: true
          }
        ]
      }
    ];
    for (const [index, manifest] of invalid.entries()) {
      await write(root, 'manifest.json', JSON.stringify(manifest));
      const result = await analyze({
        root,
        entries: ['index.html'],
        manifest: 'manifest.json',
        policy: { id: 'cff-web-strict' }
      });
      assert.equal(result.verdict, 'ToolFailure', `case ${index}`);
      assert.deepEqual(
        result.toolFailures.map((failure) => failure.code),
        ['H5A-TOOL-SETUP'],
        `case ${index}`
      );
    }
  });
});

void test('accepted semantic manifest changes alter the receipt binding', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument());
    const manifest = {
      schemaVersion: 'cff.page-manifest.v1',
      pages: { 'index.html': 'documentation' },
      requiredTheme: 'cff-evidence/1.0.0',
      requiredShellVersion: '1.0.0'
    } as const;
    await write(root, 'manifest.json', JSON.stringify(manifest));
    const first = await analyze({
      root,
      entries: ['index.html'],
      manifest: 'manifest.json',
      policy: { id: 'cff-web-strict' }
    });
    await write(
      root,
      'manifest.json',
      JSON.stringify({ ...manifest, requiredShellVersion: '1.0.1' })
    );
    const second = await analyze({
      root,
      entries: ['index.html'],
      manifest: 'manifest.json',
      policy: { id: 'cff-web-strict' }
    });
    assert.notEqual(first.verdict, 'ToolFailure');
    assert.notEqual(second.verdict, 'ToolFailure');
    assert.notDeepEqual(first.receipt.manifestDigest, second.receipt.manifestDigest);
  });
});

void test('manifest entries cannot silently bypass their required page-kind rules', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument());
    await write(
      root,
      'manifest.json',
      JSON.stringify({
        schemaVersion: 'cff.page-manifest.v1',
        entries: ['index.html'],
        pages: {},
        requiredTheme: 'cff-evidence/1.0.0'
      })
    );
    const result = await analyze({
      root,
      entries: [],
      manifest: 'manifest.json',
      policy: { id: 'cff-web-strict' }
    });
    const pageContractWasEvaluated = result.evaluations.some(
      (evaluation) =>
        (evaluation.ruleId.startsWith('H5A-CFF-') || evaluation.ruleId.startsWith('H5A-THEME-')) &&
        evaluation.outcome !== 'inapplicable'
    );
    assert.ok(
      result.verdict === 'ToolFailure' || pageContractWasEvaluated,
      'an analyzed manifest entry was silently treated as an untyped non-CFF page'
    );
  });
});

void test('a manifest policy contradiction is rejected as invalid setup', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument());
    await write(
      root,
      'manifest.json',
      JSON.stringify({
        schemaVersion: 'cff.page-manifest.v1',
        entries: ['index.html'],
        pages: { 'index.html': 'documentation' },
        requiredTheme: 'cff-evidence/1.0.0',
        html5AssayPolicy: 'cff-web-balanced'
      })
    );
    const result = await analyze({
      root,
      entries: [],
      manifest: 'manifest.json',
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(result.verdict, 'ToolFailure');
    assert.deepEqual(
      result.toolFailures.map((failure) => failure.code),
      ['H5A-TOOL-SETUP']
    );
  });
});

void test('receipt verification rejects identity and human-approval tampering', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', nativeDocument());
    const result = await analyze(requestFor(root));
    const wrongRuleset = structuredClone(result.receipt) as unknown as {
      ruleset: { digest: { value: string } };
    };
    wrongRuleset.ruleset.digest.value = '0'.repeat(64);
    assert.equal(verifyReceipt(wrongRuleset).valid, false);

    const noHumanGate = { ...result.receipt, humanApprovalRequired: false };
    assert.equal(verifyReceipt(noHumanGate).valid, false);
  });
});
