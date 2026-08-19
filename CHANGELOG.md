# Changelog

All notable changes to HTML5Assay's rules, policies, schemas, and evidence
contracts are recorded here.

## 0.1.0 — implementation candidate

Review date: 2026-08-19

- Established the `cff.assay.result.v1` result and CFF receipt contracts.
- Added `cff-web-strict` and `cff-web-balanced` data-only policy packs.
- Pinned `html5assay-standards/1.0.0` and 58 rule identifiers across document,
  semantics, accessibility, CSS, safety, CFF page, performance, and theme
  families.
- Added deterministic HTML/CSS parsing, bounded local graph construction,
  canonical JSON, SARIF 2.1.0, receipt projection, public API, and thin CLI.
- Added CFF Evidence `cff-evidence/1.0.0` light, dark, forced-colors,
  increased-contrast, and reduced-motion tokens.
- Added a bundled offline playground specimen with the exact
  `Preview only — non-authoritative` trust label. Playground source is excluded
  from the public package.
- Recorded dedicated `CanonFlow-Assay/HTML5Assay` repository placement because
  the specified CanonFlow pnpm monorepo did not exist in the supplied workspace.

This entry does not declare a release. Cross-platform, browser, accessibility,
independent review, and explicit human approval gates remain authoritative.
