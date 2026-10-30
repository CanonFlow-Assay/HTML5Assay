#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { analyze } from '../api/analyze.js';
import type { AnalyzeResult, PolicyReference } from '../api/model.js';
import { canonicalJson } from '../result/canonical.js';
import { toSarif } from '../result/sarif.js';
import { findRule, ruleCatalog, rulesetIdentity } from '../rules/catalog.js';
import { verifyReceipt } from '../receipt/receipt.js';
import { prettyResult } from './pretty.js';

type OutputFormat = 'pretty' | 'json' | 'sarif';

const usage = `html5assay 0.1.0

Usage:
  html5assay check <path> [--manifest <path>] [--policy cff-web-strict|cff-web-balanced|<id>:<file>] [--format pretty|json|sarif]
  html5assay catalog [rule-id] [--format pretty|json]
  html5assay explain <rule-id>
  html5assay verify-receipt <receipt.json>
`;

interface CheckOptions {
  readonly format: OutputFormat;
  readonly manifest?: string;
  readonly policy: PolicyReference;
}

const parseCheckOptions = (arguments_: readonly string[]): CheckOptions => {
  let format: OutputFormat = 'pretty';
  let manifest: string | undefined;
  let policy: PolicyReference = { id: 'cff-web-strict' };
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${name ?? '(missing option)'} requires a value`);
    if (name === '--format') {
      if (!['pretty', 'json', 'sarif'].includes(value)) throw new Error(`Unknown format ${value}`);
      format = value as OutputFormat;
    } else if (name === '--manifest') manifest = value;
    else if (name === '--policy') {
      const separator = value.indexOf(':');
      policy =
        separator < 0
          ? { id: value }
          : { id: value.slice(0, separator), path: value.slice(separator + 1) };
    } else throw new Error(`Unknown option ${name ?? '(missing)'}`);
  }
  return manifest === undefined ? { format, policy } : { format, manifest, policy };
};

const findHtml = async (root: string, maximum = 10_000): Promise<readonly string[]> => {
  const found: string[] = [];
  const visit = async (directory: string): Promise<boolean> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length > maximum) return true;
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory() && (await visit(absolute))) return true;
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.html')
        found.push(absolute.slice(root.length + 1));
    }
    return found.length > maximum;
  };
  await visit(root);
  return found;
};

const exitCode = (result: AnalyzeResult): number =>
  result.verdict === 'Pass'
    ? 0
    : result.verdict === 'Fail'
      ? 1
      : result.verdict === 'Inconclusive'
        ? 2
        : 3;

const check = async (path: string | undefined, arguments_: readonly string[]): Promise<number> => {
  if (path === undefined) throw new Error('check requires a path');
  const options = parseCheckOptions(arguments_);
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  const root = metadata.isDirectory() ? absolute : dirname(absolute);
  const entries =
    metadata.isDirectory() && options.manifest !== undefined
      ? []
      : metadata.isDirectory()
        ? await findHtml(root)
        : [absolute.slice(root.length + 1)];
  const result = await analyze({
    root,
    entries,
    policy: options.policy,
    ...(options.manifest === undefined ? {} : { manifest: options.manifest })
  });
  const output =
    options.format === 'json'
      ? canonicalJson(result)
      : options.format === 'sarif'
        ? canonicalJson(toSarif(result))
        : prettyResult(result);
  process.stdout.write(output);
  return exitCode(result);
};

const catalog = (arguments_: readonly string[]): number => {
  let positional: string | undefined;
  let format = 'pretty';
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === '--format') {
      const next = arguments_[index + 1];
      if (next === undefined) throw new Error('--format requires a value');
      format = next;
      index += 1;
    } else if (value?.startsWith('--') === true) throw new Error(`Unknown catalog option ${value}`);
    else if (positional === undefined && value !== undefined) positional = value;
    else throw new Error(`Unexpected catalog argument ${value ?? '(missing)'}`);
  }
  if (format !== 'pretty' && format !== 'json')
    throw new Error(`Unknown catalog format ${format ?? '(missing)'}`);
  const rules =
    positional === undefined
      ? ruleCatalog
      : [findRule(positional)].filter((rule) => rule !== undefined);
  if (positional !== undefined && rules.length === 0) throw new Error(`Unknown rule ${positional}`);
  if (format === 'json') process.stdout.write(canonicalJson({ ruleset: rulesetIdentity, rules }));
  else
    process.stdout.write(
      `${rules.map((rule) => `${rule.id} ${rule.defaultLevel} ${rule.title}`).join('\n')}\n`
    );
  return 0;
};

const main = async (): Promise<number> => {
  const [command, first, ...remaining] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(usage);
    return 0;
  }
  if (command === 'check') return check(first, remaining);
  if (command === 'catalog')
    return catalog(first === undefined ? remaining : [first, ...remaining]);
  if (command === 'explain') {
    if (remaining.length > 0) throw new Error(`Unexpected explain argument ${remaining[0] ?? ''}`);
    const rule = first === undefined ? undefined : findRule(first);
    if (rule === undefined) throw new Error(`Unknown rule ${first ?? '(missing)'}`);
    process.stdout.write(canonicalJson(rule));
    return 0;
  }
  if (command === 'verify-receipt') {
    if (remaining.length > 0)
      throw new Error(`Unexpected verify-receipt argument ${remaining[0] ?? ''}`);
    if (first === undefined) throw new Error('verify-receipt requires a path');
    const value: unknown = JSON.parse(await readFile(resolve(first), 'utf8'));
    const verification = verifyReceipt(value);
    process.stdout.write(canonicalJson(verification));
    return verification.valid ? 0 : 3;
  }
  throw new Error(`Unknown command ${command}`);
};

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `ToolFailure: ${error instanceof Error ? error.message : String(error)}\n${usage}`
  );
  process.exitCode = 3;
}
