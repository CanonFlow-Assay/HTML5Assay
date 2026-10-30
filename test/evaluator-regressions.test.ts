import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { analyze, canonicalJson, type AnalyzeResult, type PageKind } from '../src/api/index.js';

const withFixture = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'html5assay-regression-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const write = async (root: string, path: string, value: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
};
const document = (body: string, head = '', lang = 'en'): string =>
  `<!doctype html><html lang="${lang}"><head><title>Regression</title>${head}</head><body><a href="#main">Skip to primary content</a><main id="main"><h1>Regression</h1>${body}</main></body></html>`;
const outcome = (result: AnalyzeResult, id: string): string | undefined =>
  result.evaluations.find((item) => item.ruleId === id)?.outcome;
const run = async (root: string, html: string, pageKind?: PageKind): Promise<AnalyzeResult> => {
  await write(root, 'index.html', html);
  if (pageKind !== undefined)
    await write(
      root,
      'manifest.json',
      JSON.stringify({
        schemaVersion: 'cff.page-manifest.v1',
        pages: { 'index.html': pageKind },
        requiredTheme: 'cff-evidence/1.0.0'
      })
    );
  return analyze({
    root,
    entries: ['index.html'],
    policy: { id: 'cff-web-strict' },
    ...(pageKind === undefined ? {} : { manifest: 'manifest.json' })
  });
};

void test('document, language, ARIA, and caption regressions stay sound', async () => {
  await withFixture(async (root) => {
    let result = await run(root, document('<div href="x" src="y">Invalid</div>'));
    assert.equal(outcome(result, 'H5A-DOC-005'), 'failed');

    result = await run(
      root,
      document(
        '<table><caption>Builds</caption><tr><th aria-sort="ascending">State</th></tr></table>',
        '',
        'en-US-u-hc-h12'
      )
    );
    assert.equal(outcome(result, 'H5A-DOC-002'), 'passed');
    assert.notEqual(outcome(result, 'H5A-A11Y-004'), 'failed');

    result = await run(
      root,
      document('<p aria-details="detail">Summary</p><div id="detail">Detail</div>')
    );
    assert.notEqual(outcome(result, 'H5A-A11Y-004'), 'failed');

    result = await run(root, document('<h1 role="button">Wrong role</h1>'));
    assert.equal(outcome(result, 'H5A-A11Y-005'), 'failed');

    result = await run(
      root,
      document(
        '<input role="combobox" aria-label="Choice" aria-expanded="false" aria-controls="choices"><div id="choices" role="listbox"><div role="option">One</div></div>'
      )
    );
    assert.equal(outcome(result, 'H5A-A11Y-004'), 'passed');

    result = await run(
      root,
      document('<video><track kind="captions" src="https://evil.example/captions.vtt"></video>')
    );
    assert.equal(outcome(result, 'H5A-A11Y-008'), 'failed');
    assert.equal(outcome(result, 'H5A-SAFE-001'), 'failed');
  });
});

void test('focus, reduced motion, forced colors, reflow, and target-size regressions stay conservative', async () => {
  await withFixture(async (root) => {
    let result = await run(
      root,
      document('', '<style>:focus{outline:none;box-shadow:none}</style>')
    );
    assert.equal(outcome(result, 'H5A-CSS-001'), 'failed');

    result = await run(
      root,
      document('', '<style>:focus{outline:none;border:2px solid transparent}</style>')
    );
    assert.equal(outcome(result, 'H5A-CSS-001'), 'failed');

    result = await run(
      root,
      document(
        '',
        '<style>.one{animation:a 1s}.two{animation:b 1s}@media(prefers-reduced-motion:reduce){.one{animation:none}}</style>'
      )
    );
    assert.equal(outcome(result, 'H5A-CSS-006'), 'failed');

    result = await run(
      root,
      document(
        '<button>Go</button>',
        '<style>button{color:#000;background:#fff;border:1px solid #000}@media(forced-colors:active){button{color:ButtonText}}</style>'
      )
    );
    assert.equal(outcome(result, 'H5A-CSS-007'), 'cantTell');

    result = await run(
      root,
      document('', '<style>main{width:600px}@media(max-width:320px){main{width:100%}}</style>')
    );
    assert.equal(outcome(result, 'H5A-CSS-008'), 'cantTell');

    result = await run(
      root,
      document('<nav><a href="one.html">One</a><a href="two.html">Two</a></nav>')
    );
    assert.equal(outcome(result, 'H5A-CSS-005'), 'cantTell');

    result = await run(
      root,
      document(
        '<button class="one">One</button><button class="two">Two</button>',
        '<style>.one{min-width:24px}.two{min-height:24px}</style>'
      )
    );
    assert.equal(outcome(result, 'H5A-CSS-005'), 'cantTell');

    result = await run(
      root,
      document(
        '<div class="dialog"><button>Inside</button></div><button>Outside</button>',
        '<style>.dialog button{min-width:24px;min-height:24px}</style>'
      )
    );
    assert.equal(outcome(result, 'H5A-CSS-005'), 'cantTell');

    result = await run(
      root,
      document(
        '<button>Overridden</button>',
        '<style>button{min-width:24px;min-height:24px}button{min-width:auto}</style>'
      )
    );
    assert.equal(outcome(result, 'H5A-CSS-005'), 'cantTell');
  });
});

void test('tracking and CFF status checks use exact source evidence', async () => {
  await withFixture(async (root) => {
    let result = await run(
      root,
      document('<img src="mascot.png" alt="Pixel art mascot" width="40" height="40">')
    );
    assert.notEqual(outcome(result, 'H5A-SAFE-005'), 'failed');

    result = await run(root, document('<strong class="fail-status">Fail</strong>'), 'overview');
    assert.equal(outcome(result, 'H5A-CFF-007'), 'failed');

    result = await run(
      root,
      document(
        '<article class="card">Card</article>',
        '<style>.card{color:red;background:white}</style>'
      ),
      'overview'
    );
    assert.equal(outcome(result, 'H5A-THEME-001'), 'failed');
  });
});

void test('split CSS, complete URL surfaces, landmarks, and obsolete attributes stay conservative', async () => {
  await withFixture(async (root) => {
    let result = await run(
      root,
      document('<p>Low contrast text</p>', '<style>body{background:#fff}p{color:#aaa}</style>')
    );
    assert.equal(outcome(result, 'H5A-CSS-003'), 'cantTell');

    result = await run(
      root,
      document(
        '<button>Boundary</button>',
        '<style>body{background:#fff}button{border:2px solid #ddd}</style>'
      )
    );
    assert.equal(outcome(result, 'H5A-CSS-004'), 'cantTell');

    result = await run(
      root,
      document(
        '<object data="https://evil.example/object.bin"></object><embed src="https://evil.example/embed.bin">'
      )
    );
    assert.equal(outcome(result, 'H5A-SAFE-001'), 'failed');

    result = await run(
      root,
      document(
        '<form action="/search"><button formaction="https://evil.example/collect">Send</button></form>'
      )
    );
    assert.equal(outcome(result, 'H5A-SAFE-004'), 'failed');

    result = await run(
      root,
      document('<map name="m"><area href="next" target="_blank" alt="Next"></map>')
    );
    assert.equal(outcome(result, 'H5A-SAFE-003'), 'failed');

    result = await run(
      root,
      document('<nav><a href="one">One</a></nav><nav><a href="two">Two</a></nav>')
    );
    assert.equal(outcome(result, 'H5A-SEM-007'), 'failed');

    result = await run(root, document('<p align="center">Obsolete presentation</p>'));
    assert.equal(outcome(result, 'H5A-DOC-006'), 'failed');
  });
});

void test('inline style evidence is scoped to its exact host element', async () => {
  await withFixture(async (root) => {
    let result = await run(
      root,
      '<!doctype html><html lang="en"><title>Inline scope</title><body><a href="#main">Jump to content</a><main style="display:none">Auxiliary</main><main id="main"><h1>Main</h1></main></body></html>'
    );
    assert.equal(outcome(result, 'H5A-SEM-001'), 'passed');

    result = await run(
      root,
      document(
        '<button style="min-width:24px;min-height:24px">Sized</button><button>Unproved</button>'
      )
    );
    assert.equal(outcome(result, 'H5A-CSS-005'), 'cantTell');

    await write(root, 'one.png', 'one');
    await write(root, 'two.png', 'two');
    result = await run(
      root,
      document(
        '<img src="one.png" alt="One" style="aspect-ratio:1 / 1"><img src="two.png" alt="Two">'
      )
    );
    assert.equal(outcome(result, 'H5A-PERF-002'), 'failed');
  });
});

void test('base URL and embedded HTML cannot bypass offline form or runtime policy', async () => {
  await withFixture(async (root) => {
    let result = await run(
      root,
      document(
        '<base href="https://evil.example/"><form action="/search"><button>Search</button></form>'
      )
    );
    assert.equal(outcome(result, 'H5A-SAFE-004'), 'failed');

    result = await run(
      root,
      document('<iframe srcdoc="&lt;img src=https://evil.example/x&gt;"></iframe>')
    );
    assert.equal(outcome(result, 'H5A-SAFE-001'), 'failed');
  });
});

void test('web-root-relative references resolve inside the analysis root', async () => {
  await withFixture(async (root) => {
    await write(root, 'assets/site.css', 'body{}');
    const result = await run(
      root,
      document(
        '<form action="/search"><button>Search</button></form>',
        '<link rel="stylesheet" href="/assets/site.css">'
      )
    );
    assert.notEqual(outcome(result, 'H5A-DOC-007'), 'failed');
    assert.notEqual(outcome(result, 'H5A-SAFE-004'), 'failed');
    assert.ok(result.subject.digest.value.length === 64);
  });
});

void test('linked CSS findings retain CSS paths and entry order cannot change canonical output', async () => {
  await withFixture(async (root) => {
    await write(root, 's.css', '.x{background:url(https://evil.example/x.png)}');
    const result = await run(
      root,
      document('<div class="x">X</div>', '<link rel="stylesheet" href="s.css">')
    );
    const remote = result.findings.find((finding) => finding.ruleId === 'H5A-SAFE-001');
    assert.equal(remote?.path, 's.css');
    assert.equal(result.verdict, 'Fail');

    await write(root, 'a.html', document('<p>A</p>'));
    await write(root, 'b.html', document('<p>B</p>'));
    const first = await analyze({
      root,
      entries: ['a.html', 'b.html'],
      policy: { id: 'cff-web-strict' }
    });
    const reversed = await analyze({
      root,
      entries: ['b.html', 'a.html', 'a.html'],
      policy: { id: 'cff-web-strict' }
    });
    assert.equal(canonicalJson(first), canonicalJson(reversed));
  });
});
