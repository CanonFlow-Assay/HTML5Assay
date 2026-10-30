import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildGraph } from '../src/graph/build.js';
import { strictPolicy } from '../src/policy/builtins.js';

const withFixture = async (run: (root: string, parent: string) => Promise<void>): Promise<void> => {
  const parent = await mkdtemp(join(tmpdir(), 'html5assay-independent-'));
  const root = join(parent, 'root');
  await mkdir(root);
  try {
    await run(root, parent);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
};

const write = async (root: string, path: string, contents: string | Uint8Array): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
};

void test('entry traversal and entry symlink escapes are rejected', async () => {
  await withFixture(async (root, parent) => {
    const outside = join(parent, 'outside.html');
    await writeFile(outside, '<!doctype html><title>Outside</title>');
    await assert.rejects(
      buildGraph({
        root,
        entries: ['../outside.html'],
        manifest: null,
        policy: strictPolicy
      }),
      /H5A-PATH-BOUNDARY/u
    );

    await symlink(outside, join(root, 'linked.html'));
    await assert.rejects(
      buildGraph({
        root,
        entries: ['linked.html'],
        manifest: null,
        policy: strictPolicy
      }),
      /H5A-PATH-BOUNDARY/u
    );
  });
});

void test('a reference through a symlinked parent cannot read outside-root bytes', async () => {
  await withFixture(async (root, parent) => {
    const outside = join(parent, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.css'), '/* outside secret */ body { color: red }');
    await symlink(outside, join(root, 'linked'), 'dir');
    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>Inside</title>' +
        '<link rel="stylesheet" href="linked/secret.css"></head><body><main></main></body></html>'
    );

    const graph = await buildGraph({
      root,
      entries: ['index.html'],
      manifest: null,
      policy: strictPolicy
    });

    assert.deepEqual(
      graph.assets.map((asset) => asset.path),
      ['index.html']
    );
    assert.equal(graph.pages[0]?.css.length, 0);
    assert.equal(graph.references[0]?.kind, 'escape');
    assert.equal(graph.references[0]?.resolvedPath, null);
  });
});

void test('remote HTML and CSS references remain inert evidence', async () => {
  await withFixture(async (root) => {
    const sentinel = join(root, 'script-executed');
    await write(
      root,
      'index.html',
      `<!doctype html><html lang="en"><head><title>Offline</title>
<link rel="stylesheet" href="styles/site.css">
<script src="https://example.invalid/app.js"></script></head><body>
<main><img src="https://example.invalid/pixel.png" alt=""></main>
<object data="https://example.invalid/object.bin"></object>
<form><button formaction="https://example.invalid/submit">Send</button></form>
<script>require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad')</script>
</body></html>`
    );
    await write(
      root,
      'styles/site.css',
      '@import "https://example.invalid/import.css";\n' +
        '.hero { background-image: url("https://example.invalid/hero.png") }\n'
    );

    const graph = await buildGraph({
      root,
      entries: ['index.html'],
      manifest: null,
      policy: strictPolicy
    });

    assert.deepEqual(
      graph.assets.map((asset) => asset.path),
      ['index.html', 'styles/site.css']
    );
    assert.deepEqual(
      graph.references
        .filter((reference) => reference.kind === 'remote')
        .map((reference) => reference.value)
        .sort(),
      [
        'https://example.invalid/app.js',
        'https://example.invalid/hero.png',
        'https://example.invalid/import.css',
        'https://example.invalid/object.bin',
        'https://example.invalid/pixel.png',
        'https://example.invalid/submit'
      ]
    );
    assert.deepEqual(
      graph.references
        .filter((reference) =>
          ['https://example.invalid/object.bin', 'https://example.invalid/submit'].includes(
            reference.value
          )
        )
        .map(({ attribute, kind }) => ({ attribute, kind })),
      [
        { attribute: 'data', kind: 'remote' },
        { attribute: 'formaction', kind: 'remote' }
      ]
    );
    assert.deepEqual(
      graph.pages[0]?.css[0]?.urls.map(({ value, kind }) => ({ value, kind })),
      [
        { value: 'https://example.invalid/import.css', kind: 'import' },
        { value: 'https://example.invalid/hero.png', kind: 'url' }
      ]
    );
    await assert.rejects(rm(sentinel), { code: 'ENOENT' });
  });
});

void test('web-root-relative routes and assets resolve inside the analysis root', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      `<!doctype html><html lang="en"><head><title>Root URLs</title>
<link rel="stylesheet" href="/assets/site.css"></head><body>
<a href="#main">Skip to primary content</a><a href="/docs">Documentation</a>
<main id="main"><form action="/search"><button>Search</button></form></main>
</body></html>`
    );
    await write(root, 'assets/site.css', 'body { font-family: system-ui, sans-serif }\n');

    const graph = await buildGraph({
      root,
      entries: ['index.html'],
      manifest: null,
      policy: strictPolicy
    });
    assert.deepEqual(
      graph.references
        .filter((reference) => ['/assets/site.css', '/docs', '/search'].includes(reference.value))
        .map(({ value, kind, resolvedPath }) => ({ value, kind, resolvedPath })),
      [
        { value: '/assets/site.css', kind: 'local', resolvedPath: 'assets/site.css' },
        { value: '/docs', kind: 'local', resolvedPath: 'docs' },
        { value: '/search', kind: 'local', resolvedPath: 'search' }
      ]
    );
    assert.deepEqual(graph.incompleteReasons, []);
  });
});

void test('safe resource limits produce explicit incomplete evidence', async () => {
  await withFixture(async (root) => {
    await write(root, 'index.html', '<!doctype html><html lang="en"><title>Large</title></html>');
    const constrained = {
      ...strictPolicy,
      limits: { ...strictPolicy.limits, bytesPerTextFile: 16 }
    };
    const graph = await buildGraph({
      root,
      entries: ['index.html'],
      manifest: null,
      policy: constrained
    });
    assert.equal(graph.pages.length, 0);
    assert.equal(graph.assets.length, 0);
    const limitIds = graph.limits.map((limit) => limit.id);
    assert.ok(limitIds.includes('bytesPerTextFile'));
    assert.match(graph.incompleteReasons[0] ?? '', /prevented (?:reading|parsing) index\.html/u);
  });
});

void test('deep trees stop at the node limit before an incomplete page can pass', async () => {
  await withFixture(async (root) => {
    await write(
      root,
      'index.html',
      `<!doctype html><html lang="en"><title>Deep</title><body>${'<div>'.repeat(64)}deep${'</div>'.repeat(64)}</body></html>`
    );
    const constrained = {
      ...strictPolicy,
      limits: { ...strictPolicy.limits, htmlNodesPerDocument: 32 }
    };
    const graph = await buildGraph({
      root,
      entries: ['index.html'],
      manifest: null,
      policy: constrained
    });
    assert.equal(graph.pages.length, 0);
    assert.ok(
      graph.limits.some(
        (limit) =>
          limit.id === 'htmlNodesPerDocument' && limit.limit === 32 && limit.observed > limit.limit
      )
    );
    assert.match(graph.incompleteReasons.join('\n'), /prevented parsing index\.html/u);
  });
});

void test('HTML entity declarations cannot read local files', async () => {
  await withFixture(async (root, parent) => {
    const outside = join(parent, 'entity-secret.txt');
    await writeFile(outside, 'ENTITY_SECRET_MUST_NOT_APPEAR');
    await write(
      root,
      'index.html',
      `<!doctype html [<!ENTITY xxe SYSTEM "file://${outside}">]><html lang="en"><title>&xxe;</title><body><main></main></body></html>`
    );
    const graph = await buildGraph({
      root,
      entries: ['index.html'],
      manifest: null,
      policy: strictPolicy
    });
    assert.deepEqual(
      graph.assets.map((asset) => asset.path),
      ['index.html']
    );
    assert.doesNotMatch(
      graph.pages[0]?.html.elements.find((element) => element.tagName === 'title')?.text ?? '',
      /ENTITY_SECRET_MUST_NOT_APPEAR/u
    );
  });
});

void test('invalid UTF-8 and malformed required CSS fail parsing instead of passing', async () => {
  await withFixture(async (root) => {
    await write(root, 'invalid.html', new Uint8Array([0xff, 0xfe, 0xfd]));
    await assert.rejects(
      buildGraph({
        root,
        entries: ['invalid.html'],
        manifest: null,
        policy: strictPolicy
      }),
      /H5A-DECODE-UTF8/u
    );

    await write(
      root,
      'index.html',
      '<!doctype html><html lang="en"><head><title>CSS</title>' +
        '<link rel="stylesheet" href="bad.css"></head><body><main></main></body></html>'
    );
    await write(root, 'bad.css', '.broken { color: red;');
    await assert.rejects(
      buildGraph({
        root,
        entries: ['index.html'],
        manifest: null,
        policy: strictPolicy
      })
    );
  });
});
