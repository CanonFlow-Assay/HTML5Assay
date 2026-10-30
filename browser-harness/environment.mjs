import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

export const loadLockedBrowserEnvironment = async () => {
  const lock = await readJson(join(import.meta.dirname, 'environment-lock.json'));
  const repositoryPackage = await readJson(join(repositoryRoot, 'package.json'));
  const repositoryLock = await readFile(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const require = createRequire(import.meta.url);
  const playwrightPackagePath = require.resolve('playwright/package.json');
  const playwrightRequire = createRequire(playwrightPackagePath);
  const playwrightCorePackagePath = playwrightRequire.resolve('playwright-core/package.json');
  const playwrightPackage = await readJson(playwrightPackagePath);
  const playwrightCorePackage = await readJson(playwrightCorePackagePath);
  const browsers = await readJson(join(dirname(playwrightCorePackagePath), 'browsers.json'));

  if (repositoryPackage.packageManager !== lock.packageManager)
    throw new Error('Browser lock package-manager version does not match package.json');
  if (repositoryPackage.engines?.node !== lock.repositoryNode)
    throw new Error('Browser lock Node version does not match package.json');
  if (repositoryPackage.devDependencies?.playwright !== lock.playwright.version)
    throw new Error('Browser lock Playwright version is not an exact devDependency');
  if (
    playwrightPackage.version !== lock.playwright.version ||
    playwrightCorePackage.version !== lock.playwright.version
  )
    throw new Error('Installed Playwright packages do not match the browser lock');
  for (const integrity of [lock.playwright.integrity, lock.playwright.coreIntegrity]) {
    if (!repositoryLock.includes(`integrity: ${integrity}`))
      throw new Error('pnpm lockfile does not contain a locked Playwright integrity');
  }

  const installedBrowsers = browsers.browsers.filter((browser) =>
    lock.browsers.some((locked) => locked.name === browser.name)
  );
  for (const locked of lock.browsers) {
    const installed = installedBrowsers.find((browser) => browser.name === locked.name);
    if (
      installed === undefined ||
      installed.revision !== locked.revision ||
      installed.browserVersion !== locked.browserVersion
    )
      throw new Error(`Installed ${locked.name} revision does not match the browser lock`);
  }

  return {
    lock,
    playwrightVersion: playwrightPackage.version,
    browsers: lock.browsers.map((browser) => ({ ...browser }))
  };
};
