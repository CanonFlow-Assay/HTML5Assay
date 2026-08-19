import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const requiredProbes = new Set([
  'keyboard-order',
  'focus-visibility',
  'zoom-200',
  'reduced-motion',
  'forced-colors',
  'horizontal-overflow',
  'native-dialog',
  'native-popover',
  'page-state-recovery'
]);

const validateConfig = () => {
  if (config.schemaVersion !== 'html5assay.browser-harness.v1')
    throw new Error('Browser harness schemaVersion is invalid');
  if (config.network !== 'loopback-only')
    throw new Error('Browser harness must block non-loopback network access');
  if (typeof config.target !== 'string' || typeof config.flowTarget !== 'string')
    throw new Error('Browser harness targets are invalid');
  if (JSON.stringify(config.viewports) !== JSON.stringify([320, 768, 1024, 1440]))
    throw new Error('Required viewport matrix is incomplete');
  if (!['chromium', 'firefox', 'webkit'].every((name) => config.browsers.includes(name)))
    throw new Error('Required browser matrix is incomplete');
  if (![...requiredProbes].every((name) => config.probes.includes(name)))
    throw new Error('Required browser probes are incomplete');
  if (config.humanApprovalRequired !== true) throw new Error('Human approval gate is missing');
};

validateConfig();
if (process.argv.includes('--validate')) {
  process.stdout.write('browser harness contract valid\n');
  process.exit(0);
}

const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/plain',
  '.mjs': 'text/javascript'
};
const server = createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    );
    const candidate = resolve(repositoryRoot, `.${requestPath}`);
    const fromRoot = relative(repositoryRoot, candidate);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
      throw new Error('request escaped harness root');
    response.setHeader('content-type', mime[extname(candidate)] ?? 'application/octet-stream');
    response.end(await readFile(candidate));
  } catch {
    response.statusCode = 404;
    response.end('not found');
  }
});

await new Promise((resolveReady, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveReady);
});

const address = server.address();
if (address === null || typeof address === 'string')
  throw new Error('Browser harness did not acquire a loopback port');
const origin = `http://127.0.0.1:${address.port}`;
const evidence = {
  schemaVersion: 'html5assay.browser-evidence.v1',
  authoritative: false,
  network: 'loopback-only',
  target: config.target,
  flowTarget: config.flowTarget,
  results: [],
  failures: [],
  humanApprovalRequired: true
};

const assertion = (condition, scope, message) => {
  if (!condition) evidence.failures.push({ scope, message });
};

const installNetworkBoundary = async (context, blocked) => {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) await route.continue();
    else {
      blocked.push(url.href);
      await route.abort('blockedbyclient');
    }
  });
};

const openIsolatedPage = async (browser, width, options = {}) => {
  const blocked = [];
  const context = await browser.newContext({ viewport: { width, height: 900 }, ...options });
  await installNetworkBoundary(context, blocked);
  const page = await context.newPage();
  return { context, page, blocked };
};

const keyboardEvidence = async (page) => {
  const selector =
    'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),' +
    'select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  const expected = await page.locator(selector).evaluateAll(
    (candidates) =>
      candidates.filter((candidate) => {
        const style = getComputedStyle(candidate);
        return style.display !== 'none' && style.visibility !== 'hidden' && !candidate.hidden;
      }).length
  );
  const sequence = [];
  for (let index = 0; index < expected; index += 1) {
    await page.keyboard.press('Tab');
    sequence.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        const style = active === null ? null : getComputedStyle(active);
        const outline =
          style !== null &&
          style.outlineStyle !== 'none' &&
          Number.parseFloat(style.outlineWidth) > 0;
        return {
          key:
            active === null
              ? '(none)'
              : `${active.tagName.toLowerCase()}#${active.id || active.getAttribute('href') || active.getAttribute('name') || ''}`,
          focusVisible: active?.matches(':focus-visible') === true,
          indicator: outline || (style !== null && style.boxShadow !== 'none')
        };
      })
    );
  }
  return { expected, sequence };
};

const overflowEvidence = (page) =>
  page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));

const runDefaultMode = async (browser, browserName, width) => {
  const scope = `${browserName}/${width}/default`;
  const { context, page, blocked } = await openIsolatedPage(browser, width);
  try {
    await page.goto(`${origin}${config.target}`, { waitUntil: 'networkidle' });
    const keyboard = await keyboardEvidence(page);
    const overflow = await overflowEvidence(page);
    const keys = keyboard.sequence.map((item) => item.key);
    assertion(keyboard.expected > 0, scope, 'No keyboard-focusable product controls were found');
    assertion(
      new Set(keys).size === keyboard.expected,
      scope,
      'Tab traversal did not visit every focusable exactly once'
    );
    assertion(
      keyboard.sequence.every((item) => item.focusVisible && item.indicator),
      scope,
      'Every keyboard stop must expose a visible :focus-visible indicator'
    );
    assertion(overflow.fits, scope, 'The product page has horizontal overflow');
    assertion(blocked.length === 0, scope, 'The product attempted a non-loopback request');
    evidence.results.push({
      browser: browserName,
      width,
      mode: 'default',
      keyboard,
      overflow,
      blocked
    });
  } finally {
    await context.close();
  }
};

const runZoomMode = async (browser, browserName, width) => {
  const scope = `${browserName}/${width}/zoom-200`;
  const layoutWidth = Math.max(160, Math.floor(width / 2));
  const { context, page, blocked } = await openIsolatedPage(browser, layoutWidth);
  try {
    await page.goto(`${origin}${config.target}`, { waitUntil: 'networkidle' });
    const before = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.body).fontSize)
    );
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const after = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.body).fontSize)
    );
    const overflow = await overflowEvidence(page);
    assertion(after >= before * 1.9, scope, 'Portable 200% text resize was not applied');
    assertion(overflow.fits, scope, '200% text and half-width zoom-equivalent layout overflows');
    assertion(blocked.length === 0, scope, 'The zoom probe attempted a non-loopback request');
    evidence.results.push({
      browser: browserName,
      width,
      mode: 'zoom-200',
      layoutWidth,
      textPixels: { before, after },
      overflow,
      blocked
    });
  } finally {
    await context.close();
  }
};

const runReducedMotionMode = async (browser, browserName, width) => {
  const scope = `${browserName}/${width}/reduced-motion`;
  const { context, page, blocked } = await openIsolatedPage(browser, width, {
    reducedMotion: 'reduce'
  });
  try {
    await page.goto(`${origin}${config.target}`, { waitUntil: 'networkidle' });
    const result = await page.evaluate(() => ({
      matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      activeAnimations: document
        .getAnimations()
        .filter((animation) => animation.playState === 'running').length
    }));
    assertion(result.matches, scope, 'Reduced-motion emulation is not active');
    assertion(result.activeAnimations === 0, scope, 'Product motion remains active in reduce mode');
    assertion(blocked.length === 0, scope, 'Reduced-motion mode attempted a non-loopback request');
    evidence.results.push({
      browser: browserName,
      width,
      mode: 'reduced-motion',
      ...result,
      blocked
    });
  } finally {
    await context.close();
  }
};

const runForcedColorsMode = async (browser, browserName, width) => {
  const scope = `${browserName}/${width}/forced-colors`;
  const { context, page, blocked } = await openIsolatedPage(browser, width, {
    forcedColors: 'active'
  });
  try {
    await page.goto(`${origin}${config.target}`, { waitUntil: 'networkidle' });
    const result = await page.evaluate(() => {
      const control = document.querySelector('.primary-action');
      const style = control === null ? null : getComputedStyle(control);
      return {
        matches: matchMedia('(forced-colors: active)').matches,
        controlPresent: control !== null,
        boundaryVisible:
          style !== null &&
          style.borderStyle !== 'none' &&
          Number.parseFloat(style.borderWidth) > 0,
        forcedColorAdjust: style?.forcedColorAdjust ?? null
      };
    });
    assertion(result.matches, scope, 'Forced-colors emulation is not active');
    assertion(result.controlPresent && result.boundaryVisible, scope, 'Control boundary is lost');
    assertion(blocked.length === 0, scope, 'Forced-colors mode attempted a non-loopback request');
    evidence.results.push({
      browser: browserName,
      width,
      mode: 'forced-colors',
      ...result,
      blocked
    });
  } finally {
    await context.close();
  }
};

const runNativeFlows = async (browser, browserName) => {
  const scope = `${browserName}/native-flows`;
  const { context, page, blocked } = await openIsolatedPage(browser, 768);
  try {
    await page.goto(`${origin}${config.flowTarget}`, { waitUntil: 'networkidle' });
    await page.click('#open-dialog');
    const dialogOpen = await page.locator('#review-dialog').evaluate((dialog) => dialog.open);
    const dialogFocus = await page.evaluate(() =>
      document.querySelector('#review-dialog')?.contains(document.activeElement)
    );
    await page.click('#close-dialog');
    const dialogClosed = await page.locator('#review-dialog').evaluate((dialog) => !dialog.open);

    const popoverSupported = await page.evaluate(() => 'showPopover' in HTMLElement.prototype);
    let popoverOpened = false;
    let popoverClosed = false;
    if (popoverSupported) {
      await page.click('#open-popover');
      popoverOpened = await page
        .locator('#review-popover')
        .evaluate((item) => item.matches(':popover-open'));
      await page.keyboard.press('Escape');
      popoverClosed = await page
        .locator('#review-popover')
        .evaluate((item) => !item.matches(':popover-open'));
    }

    const marker = `restored-${browserName}`;
    await page.fill('#recovery-value', marker);
    await page.reload({ waitUntil: 'networkidle' });
    const recovery = {
      value: await page.locator('#recovery-value').inputValue(),
      status: await page.locator('#recovery-status').textContent()
    };
    assertion(
      dialogOpen && dialogFocus === true && dialogClosed,
      scope,
      'Native dialog flow failed'
    );
    assertion(
      popoverSupported && popoverOpened && popoverClosed,
      scope,
      'Native popover flow failed'
    );
    assertion(
      recovery.value === marker && recovery.status?.includes(marker) === true,
      scope,
      'Page state was not recovered after reload'
    );
    assertion(blocked.length === 0, scope, 'Native flow attempted a non-loopback request');
    evidence.results.push({
      browser: browserName,
      width: 768,
      mode: 'native-flows',
      dialog: { opened: dialogOpen, focusContained: dialogFocus, closed: dialogClosed },
      popover: { supported: popoverSupported, opened: popoverOpened, closed: popoverClosed },
      recovery,
      blocked
    });
  } finally {
    await context.close();
  }
};

const outputArgument = process.argv.find((argument) => argument.endsWith('.json'));
const outputPath = resolve(outputArgument ?? 'browser-evidence.json');

try {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('The separate browser harness requires an external Playwright installation');
  }
  for (const browserName of config.browsers) {
    const browserType = playwright[browserName];
    if (browserType === undefined)
      throw new Error(`Playwright browser type ${browserName} is unavailable`);
    const browser = await browserType.launch({ headless: true });
    try {
      for (const width of config.viewports) {
        await runDefaultMode(browser, browserName, width);
        await runZoomMode(browser, browserName, width);
        await runReducedMotionMode(browser, browserName, width);
        await runForcedColorsMode(browser, browserName, width);
      }
      await runNativeFlows(browser, browserName);
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  evidence.failures.push({
    scope: 'harness',
    message: error instanceof Error ? error.message : String(error)
  });
} finally {
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await new Promise((resolveClosed) => server.close(resolveClosed));
}

if (evidence.failures.length > 0) {
  process.stderr.write(`${evidence.failures.length} browser qualification assertion(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`browser qualification passed; evidence: ${outputPath}\n`);
}
