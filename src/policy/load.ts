import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type {
  FindingLevel,
  PageKind,
  PageManifest,
  PolicyPack,
  PolicyReference,
  SuppressionRecord
} from '../api/model.js';
import { canonicalDigest } from '../result/canonical.js';
import { ruleIds } from '../rules/catalog.js';
import { balancedPolicy, strictPolicy } from './builtins.js';

export interface LoadedPolicy {
  readonly pack: PolicyPack;
  readonly digest: ReturnType<typeof canonicalDigest>;
}

export interface LoadedManifest {
  readonly manifest: PageManifest;
  readonly digest: ReturnType<typeof canonicalDigest>;
  readonly path: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const rejectExecutableData = (value: unknown, at = '$'): void => {
  if (typeof value === 'string' && /^(?:https?:)?\/\//iu.test(value.trim())) {
    throw new Error(`Policy packs cannot contain a remote reference at ${at}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectExecutableData(item, `${at}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (['script', 'scripts', 'import', 'imports', 'expression', 'regex', 'remote'].includes(key)) {
      throw new Error(`Policy packs cannot contain executable or remote field ${at}.${key}`);
    }
    rejectExecutableData(item, `${at}.${key}`);
  }
};

const requireOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  at: string
): void => {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown data field ${at}.${key}`);
  }
};

const isCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const requirePositiveInteger = (record: Readonly<Record<string, unknown>>, key: string): number => {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Policy ${key} must be a positive integer`);
  }
  return value as number;
};

const parseSuppressions = (value: unknown): readonly SuppressionRecord[] => {
  if (!Array.isArray(value)) throw new Error('Policy suppressions must be an array');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Suppression ${index} must be an object`);
    requireOnlyKeys(
      item,
      ['ruleId', 'path', 'owner', 'reason', 'expires'],
      `$.suppressions[${index}]`
    );
    const { ruleId, path, owner, reason, expires } = item;
    if (
      typeof ruleId !== 'string' ||
      !ruleIds.includes(ruleId) ||
      (path !== undefined && typeof path !== 'string') ||
      typeof owner !== 'string' ||
      owner.trim() === '' ||
      typeof reason !== 'string' ||
      reason.trim() === '' ||
      typeof expires !== 'string' ||
      !isCalendarDate(expires)
    ) {
      throw new Error(`Suppression ${index} is invalid`);
    }
    return path === undefined
      ? { ruleId, owner, reason, expires }
      : { ruleId, path, owner, reason, expires };
  });
};

const parsePolicy = (value: unknown): PolicyPack => {
  rejectExecutableData(value);
  if (!isRecord(value) || value.schemaVersion !== 'cff.html5assay.policy.v1') {
    throw new Error('Policy schemaVersion must be cff.html5assay.policy.v1');
  }
  requireOnlyKeys(
    value,
    [
      'schemaVersion',
      'id',
      'version',
      'profile',
      'reviewDate',
      'levels',
      'limits',
      'pageBudgets',
      'allowedFormActions',
      'suppressions',
      'signature'
    ],
    '$'
  );
  if (
    typeof value.id !== 'string' ||
    value.id.trim() === '' ||
    typeof value.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    typeof value.reviewDate !== 'string' ||
    !isCalendarDate(value.reviewDate) ||
    (value.profile !== 'strict' && value.profile !== 'balanced') ||
    !isRecord(value.levels) ||
    !isRecord(value.limits) ||
    !isRecord(value.pageBudgets) ||
    !isStringArray(value.allowedFormActions)
  ) {
    throw new Error(
      'Policy identity, profile, levels, limits, budgets, or form actions are invalid'
    );
  }
  requireOnlyKeys(
    value.limits,
    [
      'inputFiles',
      'bytesPerTextFile',
      'totalAnalyzedBytes',
      'htmlNodesPerDocument',
      'cssRulesPerGraph',
      'localReferenceDepth',
      'findings'
    ],
    '$.limits'
  );
  requireOnlyKeys(value.pageBudgets, ['default', 'playground'], '$.pageBudgets');
  const levels: Record<string, FindingLevel | 'off'> = {};
  for (const [id, level] of Object.entries(value.levels)) {
    if (!ruleIds.includes(id) || !['blocking', 'advisory', 'off'].includes(String(level))) {
      throw new Error(`Policy level override ${id} is invalid`);
    }
    levels[id] = level as FindingLevel | 'off';
  }
  const signature = value.signature;
  if (
    signature !== undefined &&
    (!isRecord(signature) ||
      typeof signature.algorithm !== 'string' ||
      typeof signature.keyId !== 'string' ||
      typeof signature.value !== 'string')
  ) {
    throw new Error('Policy signature must contain algorithm, keyId, and value strings');
  }
  if (isRecord(signature))
    requireOnlyKeys(signature, ['algorithm', 'keyId', 'value'], '$.signature');
  const pack: PolicyPack = {
    schemaVersion: 'cff.html5assay.policy.v1',
    id: value.id,
    version: value.version,
    profile: value.profile,
    reviewDate: value.reviewDate,
    levels,
    limits: {
      inputFiles: requirePositiveInteger(value.limits, 'inputFiles'),
      bytesPerTextFile: requirePositiveInteger(value.limits, 'bytesPerTextFile'),
      totalAnalyzedBytes: requirePositiveInteger(value.limits, 'totalAnalyzedBytes'),
      htmlNodesPerDocument: requirePositiveInteger(value.limits, 'htmlNodesPerDocument'),
      cssRulesPerGraph: requirePositiveInteger(value.limits, 'cssRulesPerGraph'),
      localReferenceDepth: requirePositiveInteger(value.limits, 'localReferenceDepth'),
      findings: requirePositiveInteger(value.limits, 'findings')
    },
    pageBudgets: {
      default: requirePositiveInteger(value.pageBudgets, 'default'),
      playground: requirePositiveInteger(value.pageBudgets, 'playground')
    },
    allowedFormActions: value.allowedFormActions,
    suppressions: parseSuppressions(value.suppressions ?? [])
  };
  return signature === undefined
    ? pack
    : {
        ...pack,
        signature: {
          algorithm: signature.algorithm as string,
          keyId: signature.keyId as string,
          value: signature.value as string
        }
      };
};

export const loadPolicy = async (
  reference: PolicyReference,
  root: string
): Promise<LoadedPolicy> => {
  let pack: PolicyPack;
  if (reference.id === strictPolicy.id && reference.path === undefined) pack = strictPolicy;
  else if (reference.id === balancedPolicy.id && reference.path === undefined)
    pack = balancedPolicy;
  else {
    if (reference.path === undefined) throw new Error(`Unknown built-in policy ${reference.id}`);
    const policyPath = isAbsolute(reference.path) ? reference.path : resolve(root, reference.path);
    const parsed: unknown = JSON.parse(await readFile(policyPath, 'utf8'));
    pack = parsePolicy(parsed);
    if (pack.id !== reference.id)
      throw new Error(`Policy id ${pack.id} does not match ${reference.id}`);
  }
  return { pack, digest: canonicalDigest(pack) };
};

const pageKinds = new Set<PageKind>([
  'overview',
  'documentation',
  'playground',
  'results',
  'catalogue',
  'evidence',
  'governance',
  'changelog',
  'status'
]);

export const loadManifest = async (path: string, root: string): Promise<LoadedManifest> => {
  const manifestPath = isAbsolute(path) ? path : resolve(root, path);
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 'cff.page-manifest.v1' ||
    value.requiredTheme !== 'cff-evidence/1.0.0' ||
    !isRecord(value.pages)
  ) {
    throw new Error('Manifest schema, required theme, or pages are invalid');
  }
  requireOnlyKeys(
    value,
    [
      'schemaVersion',
      'root',
      'entries',
      'pages',
      'fragments',
      'localAssetRoots',
      'generatedExclusions',
      'requiredShellVersion',
      'requiredTheme',
      'html5AssayPolicy',
      'typescriptAssayProfile',
      'steAssayPolicy',
      'deploymentHeaders',
      'approvedSuppressions'
    ],
    '$manifest'
  );
  const stringFields = [
    'root',
    'requiredShellVersion',
    'html5AssayPolicy',
    'typescriptAssayProfile',
    'steAssayPolicy',
    'deploymentHeaders'
  ];
  for (const key of stringFields) {
    if (value[key] !== undefined && typeof value[key] !== 'string')
      throw new Error(`Manifest ${key} must be a string`);
  }
  for (const key of ['entries', 'localAssetRoots', 'generatedExclusions']) {
    const item = value[key];
    if (item !== undefined && (!isStringArray(item) || new Set(item).size !== item.length))
      throw new Error(`Manifest ${key} must be an array of unique strings`);
  }
  const pages: Record<string, PageKind> = {};
  for (const [pathKey, kind] of Object.entries(value.pages)) {
    if (typeof kind !== 'string' || !pageKinds.has(kind as PageKind)) {
      throw new Error(`Manifest page kind for ${pathKey} is invalid`);
    }
    pages[pathKey.replaceAll('\\', '/')] = kind as PageKind;
  }
  let fragments: PageManifest['fragments'];
  if (value.fragments !== undefined) {
    if (!isRecord(value.fragments)) throw new Error('Manifest fragments must be an object');
    const parsed: Record<
      string,
      { contextElement: string; contextNamespace?: 'html' | 'svg' | 'mathml' }
    > = {};
    for (const [pathKey, context] of Object.entries(value.fragments)) {
      if (
        !isRecord(context) ||
        typeof context.contextElement !== 'string' ||
        context.contextElement.trim() === ''
      ) {
        throw new Error(`Fragment context for ${pathKey} is invalid`);
      }
      requireOnlyKeys(
        context,
        ['contextElement', 'contextNamespace'],
        `$manifest.fragments.${pathKey}`
      );
      const namespace = context.contextNamespace;
      if (
        namespace !== undefined &&
        (typeof namespace !== 'string' || !['html', 'svg', 'mathml'].includes(namespace))
      ) {
        throw new Error(`Fragment namespace for ${pathKey} is invalid`);
      }
      parsed[pathKey.replaceAll('\\', '/')] =
        namespace === undefined
          ? { contextElement: context.contextElement }
          : {
              contextElement: context.contextElement,
              contextNamespace: namespace as 'html' | 'svg' | 'mathml'
            };
    }
    fragments = parsed;
  }
  const manifest: PageManifest = {
    schemaVersion: 'cff.page-manifest.v1',
    pages,
    requiredTheme: 'cff-evidence/1.0.0',
    ...(fragments === undefined ? {} : { fragments }),
    ...(isStringArray(value.entries) ? { entries: value.entries } : {}),
    ...(isStringArray(value.localAssetRoots) ? { localAssetRoots: value.localAssetRoots } : {}),
    ...(isStringArray(value.generatedExclusions)
      ? { generatedExclusions: value.generatedExclusions }
      : {}),
    ...(typeof value.root === 'string' ? { root: value.root } : {}),
    ...(typeof value.requiredShellVersion === 'string'
      ? { requiredShellVersion: value.requiredShellVersion }
      : {}),
    ...(typeof value.html5AssayPolicy === 'string'
      ? { html5AssayPolicy: value.html5AssayPolicy }
      : {}),
    ...(typeof value.typescriptAssayProfile === 'string'
      ? { typescriptAssayProfile: value.typescriptAssayProfile }
      : {}),
    ...(typeof value.steAssayPolicy === 'string' ? { steAssayPolicy: value.steAssayPolicy } : {}),
    ...(typeof value.deploymentHeaders === 'string'
      ? { deploymentHeaders: value.deploymentHeaders }
      : {}),
    ...(value.approvedSuppressions === undefined
      ? {}
      : { approvedSuppressions: parseSuppressions(value.approvedSuppressions) })
  };
  return { manifest, digest: canonicalDigest(manifest), path: manifestPath };
};
