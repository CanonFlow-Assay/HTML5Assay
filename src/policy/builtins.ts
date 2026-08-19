import type { PolicyPack } from '../api/model.js';

const limits = {
  inputFiles: 10_000,
  bytesPerTextFile: 4 * 1024 * 1024,
  totalAnalyzedBytes: 64 * 1024 * 1024,
  htmlNodesPerDocument: 250_000,
  cssRulesPerGraph: 100_000,
  localReferenceDepth: 32,
  findings: 20_000
} as const;

export const strictPolicy: PolicyPack = {
  schemaVersion: 'cff.html5assay.policy.v1',
  id: 'cff-web-strict',
  version: '1.0.0',
  profile: 'strict',
  reviewDate: '2026-08-19',
  levels: {},
  limits,
  pageBudgets: { default: 750 * 1024, playground: 2 * 1024 * 1024 },
  allowedFormActions: ['', '/search'],
  suppressions: []
};

export const balancedPolicy: PolicyPack = {
  ...strictPolicy,
  id: 'cff-web-balanced',
  profile: 'balanced',
  levels: {
    'H5A-CFF-001': 'advisory',
    'H5A-CFF-002': 'advisory',
    'H5A-CFF-006': 'advisory',
    'H5A-PERF-004': 'advisory',
    'H5A-THEME-001': 'advisory',
    'H5A-THEME-002': 'advisory',
    'H5A-THEME-003': 'advisory',
    'H5A-THEME-004': 'advisory',
    'H5A-THEME-005': 'advisory',
    'H5A-THEME-006': 'advisory'
  }
};
