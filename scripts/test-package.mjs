import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const run = (args, cwd, { offline = true } = {}) =>
  new Promise((resolveRun, reject) => {
    const environment = {
      ...process.env,
      CI: 'true'
    };
    if (offline) environment.npm_config_offline = 'true';
    else delete environment.npm_config_offline;
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}`))
    );
  });

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const repositoryRoot = resolve(import.meta.dirname, '..');
const repositoryPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
if (!/^pnpm@10\./u.test(repositoryPackage.packageManager)) {
  throw new Error('Package qualification requires the repository-pinned pnpm 10 toolchain');
}
const temporaryRoot = await mkdtemp(join(tmpdir(), 'html5assay-package-'));
const archiveDirectory = join(temporaryRoot, 'archive');
const consumer = join(temporaryRoot, 'consumer');

try {
  await mkdir(archiveDirectory, { recursive: true });
  await run(['pack', '--pack-destination', archiveDirectory], repositoryRoot);
  const archives = (await readdir(archiveDirectory)).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1)
    throw new Error(`Expected one packed archive, found ${archives.length}`);
  const archive = join(archiveDirectory, archives[0]);
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'html5assay-packed-consumer',
      private: true,
      type: 'module',
      packageManager: repositoryPackage.packageManager,
      dependencies: { '@canonflow/html5-assay': `file:${archive}` }
    })
  );
  // A cold machine cannot install dependencies offline until their exact package
  // metadata and bytes have been cached. Seed that cache without running scripts,
  // remove the complete install, and qualify a fresh install with networking
  // disabled and the resulting lockfile frozen.
  await run(['install', '--ignore-scripts', '--no-frozen-lockfile'], consumer, {
    offline: false
  });
  await rm(join(consumer, 'node_modules'), { recursive: true, force: true });
  await run(['install', '--offline', '--ignore-scripts', '--frozen-lockfile'], consumer);
  await writeFile(
    join(consumer, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><title>Packed consumer</title></head><body><a href="#main">Jump to content</a><main id="main"><h1>Packed consumer</h1></main></body></html>'
  );
  await writeFile(
    join(consumer, 'verify.mjs'),
    `
    import { analyze, ruleCatalog } from '@canonflow/html5-assay';
    const result = await analyze({ root: '.', entries: ['index.html'], policy: { id: 'cff-web-strict' } });
    if (result.assay.id !== 'html5assay' || result.schemaVersion !== 'cff.assay.result.v1') throw new Error('Packed API failed');
    if (ruleCatalog.length !== 58) throw new Error('Packed catalogue is incomplete');
  `
  );
  const nodeCommand = process.platform === 'win32' ? 'node.exe' : 'node';
  await new Promise((resolveRun, reject) => {
    const child = spawn(nodeCommand, ['verify.mjs'], {
      cwd: consumer,
      stdio: 'inherit',
      env: { ...process.env, npm_config_offline: 'true' }
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`Packed API consumer exited ${String(code)}`))
    );
  });
  await run(['exec', 'html5assay', 'catalog', 'H5A-DOC-001', '--format', 'json'], consumer);

  const installed = join(consumer, 'node_modules', '@canonflow', 'html5-assay');
  for (const required of [
    'dist/src/api/index.js',
    'theme/cff-evidence.css',
    'schemas/result.schema.json',
    'fixtures/path-traversal.fixture.json'
  ]) {
    if (!(await exists(join(installed, required))))
      throw new Error(`Packed archive omitted ${required}`);
  }
  for (const forbidden of ['playground', 'test', 'browser-harness', 'scripts']) {
    if (await exists(join(installed, forbidden)))
      throw new Error(`Packed archive unexpectedly contains ${forbidden}`);
  }
  const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  if ('main' in installedPackage || installedPackage.exports === undefined)
    throw new Error('Packed entry-point metadata is invalid');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
