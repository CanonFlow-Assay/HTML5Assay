import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse, serialize } from 'parse5';
import postcss from 'postcss';

interface Specimen {
  readonly id: string;
  readonly policy: string;
  readonly expectedVerdict: 'Fail' | 'Inconclusive';
  readonly expectedFindingIds: readonly string[];
  readonly digest: string;
  readonly input: string;
}

interface FakeListener {
  (): unknown;
}

class FakeElement {
  value = '';
  textContent = '';
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, FakeListener>();

  append(...items: Array<FakeElement | string>): void {
    for (const item of items) {
      if (typeof item === 'string') this.textContent += item;
      else this.children.push(item);
    }
  }

  replaceChildren(...items: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...items);
  }

  addEventListener(name: string, listener: FakeListener): void {
    this.listeners.set(name, listener);
  }

  focus(): void {}
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for playground analysis');
};

const luminance = (hex: string): number => {
  const numeric = Number.parseInt(hex.slice(1), 16);
  const channels = [(numeric >> 16) & 255, (numeric >> 8) & 255, numeric & 255].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
};

const contrast = (foreground: string, background: string): number => {
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
};

void test('bundled specimen digests bind the exact input bytes', async () => {
  const specimenModule = pathToFileURL(resolve('playground/specimens.mjs')).href;
  const module = (await import(specimenModule)) as {
    readonly specimens: readonly Specimen[];
  };
  assert.equal(module.specimens.length, 2);
  for (const specimen of module.specimens) {
    assert.match(specimen.digest, /^[a-f0-9]{64}$/u);
    assert.equal(sha256(specimen.input), specimen.digest, specimen.id);
    assert.equal(specimen.policy, 'cff-web-strict');
  }
  assert.deepEqual(
    module.specimens.map(({ id, expectedVerdict, expectedFindingIds }) => ({
      id,
      expectedVerdict,
      expectedFindingIds
    })),
    [
      {
        id: 'minimal-pass',
        expectedVerdict: 'Inconclusive',
        expectedFindingIds: []
      },
      {
        id: 'unsafe-runtime',
        expectedVerdict: 'Fail',
        expectedFindingIds: ['H5A-SAFE-001', 'H5A-SAFE-002']
      }
    ]
  );
});

void test('playground keeps a clear preview Inconclusive and finds the unsafe specimen', async () => {
  const ids = [
    'source',
    'example',
    'policy',
    'load-example',
    'analyze',
    'example-status',
    'specimen-identity',
    'verdict-card',
    'verdict',
    'verdict-icon',
    'result-summary',
    'result-policy',
    'subject-digest',
    'findings'
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const fakeDocument = {
    getElementById(id: string): FakeElement | undefined {
      return elements.get(id);
    },
    createElement(): FakeElement {
      return new FakeElement();
    }
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousDocument = globals['document'];
  globals['document'] = fakeDocument;
  try {
    const playgroundModule = pathToFileURL(resolve('playground/playground.mjs')).href;
    await import(`${playgroundModule}?test=${Date.now().toString()}`);
    const analyze = elements.get('analyze');
    const loadExample = elements.get('load-example');
    const example = elements.get('example');
    assert.ok(analyze);
    assert.ok(loadExample);
    assert.ok(example);

    analyze.listeners.get('click')?.();
    await waitFor(() => elements.get('verdict-card')?.dataset.verdict === 'Inconclusive');
    assert.equal(elements.get('verdict-card')?.dataset.verdict, 'Inconclusive');
    assert.equal(elements.get('verdict')?.textContent, 'Preview — Inconclusive');
    assert.match(
      elements.get('result-summary')?.textContent ?? '',
      /^0 blocking preview findings;/u
    );

    example.value = 'unsafe-runtime';
    loadExample.listeners.get('click')?.();
    analyze.listeners.get('click')?.();
    await waitFor(() => elements.get('verdict-card')?.dataset.verdict === 'Fail');
    assert.equal(elements.get('verdict-card')?.dataset.verdict, 'Fail');
    assert.deepEqual(
      elements
        .get('findings')
        ?.children.map((item) => item.children[0]?.textContent.replace('html5assay-preview · ', ''))
        .sort(),
      ['H5A-SAFE-001', 'H5A-SAFE-002']
    );
  } finally {
    if (previousDocument === undefined) delete globals['document'];
    else globals['document'] = previousDocument;
  }
});

void test('playground page is local-first and exposes the required shell and trust label', async () => {
  const source = await readFile('playground/index.html', 'utf8');
  const document = parse(source);
  const serialized = serialize(document);
  assert.match(source, /^<!doctype html>/iu);
  assert.match(source, /href="#main">Skip to primary content</u);
  assert.match(source, /<header\s+class="product-header"/u);
  assert.match(source, /<nav aria-label="Primary">/u);
  assert.match(source, /<main class="shell" id="main">/u);
  assert.match(source, /<footer class="product-footer">/u);
  assert.match(source, /Preview only — non-authoritative/u);
  assert.match(source, /connect-src 'none'/u);
  assert.doesNotMatch(source, /(?:src|href)="https?:\/\//iu);
  assert.ok(source.indexOf('class="input-panel') < source.indexOf('class="result-panel'));
  assert.ok(serialized.includes('HTML5Assay offline playground'));
});

void test('CFF Evidence declares every required role and meets the verified contrast matrix', async () => {
  const source = await readFile('theme/cff-evidence.css', 'utf8');
  const root = postcss.parse(source);
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  root.walkDecls((declaration) => {
    if (!declaration.prop.startsWith('--cf-')) return;
    const context = declaration.parent?.parent;
    const darkMode =
      context?.type === 'atrule' &&
      context.name === 'media' &&
      context.params.includes('prefers-color-scheme: dark');
    if (darkMode) dark[declaration.prop] = declaration.value;
    else if (context?.type === 'root') light[declaration.prop] = declaration.value;
  });
  const roles = [
    'bg',
    'surface',
    'surface-raised',
    'glass',
    'text',
    'text-muted',
    'outline',
    'scrim',
    'primary',
    'on-primary',
    'primary-container',
    'on-primary-container',
    'secondary',
    'on-secondary',
    'secondary-container',
    'on-secondary-container',
    'tertiary',
    'on-tertiary',
    'tertiary-container',
    'on-tertiary-container',
    'pass',
    'check',
    'fail',
    'focus'
  ].map((role) => `--cf-${role}`);
  assert.deepEqual(
    roles.filter((role) => light[role] === undefined),
    []
  );
  assert.deepEqual(
    roles.filter((role) => dark[role] === undefined),
    []
  );

  const pairs = [
    ['text', 'bg', 4.5],
    ['text-muted', 'bg', 4.5],
    ['outline', 'surface', 3],
    ['on-primary', 'primary', 4.5],
    ['on-primary-container', 'primary-container', 4.5],
    ['on-secondary', 'secondary', 4.5],
    ['on-secondary-container', 'secondary-container', 4.5],
    ['on-tertiary', 'tertiary', 4.5],
    ['on-tertiary-container', 'tertiary-container', 4.5],
    ['pass', 'bg', 4.5],
    ['check', 'bg', 4.5],
    ['fail', 'bg', 4.5],
    ['focus', 'bg', 3]
  ] as const;
  for (const [foreground, background, minimum] of pairs) {
    for (const [scheme, tokens] of [
      ['light', light],
      ['dark', dark]
    ] as const) {
      const foregroundValue = tokens[`--cf-${foreground}`];
      const backgroundValue = tokens[`--cf-${background}`];
      assert.ok(foregroundValue, `${scheme} ${foreground}`);
      assert.ok(backgroundValue, `${scheme} ${background}`);
      assert.ok(
        contrast(foregroundValue, backgroundValue) >= minimum,
        `${scheme} ${foreground} on ${background}`
      );
    }
  }
});
