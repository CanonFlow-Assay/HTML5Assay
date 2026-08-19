# HTML5Assay

HTML5Assay is an offline-first TypeScript library and command-line tool for
deterministic static checks of HTML, embedded CSS, linked local CSS, and the
CanonFlow Foundation (CFF) web contract.

The package is `@canonflow/html5-assay`. The command is `html5assay`.

> Status: pre-release implementation of the 0.1.0 design. Results are static
> evidence, not certification or proof of complete WCAG conformance. Human
> approval is required before release, signature, waiver, or promotion.

## What it does

- Parses supplied HTML and local CSS without executing page scripts.
- Builds a path-bounded local asset graph without fetching network resources.
- Runs 58 versioned rules covering documents, semantics, accessibility, CSS,
  safety, CFF pages, performance, and the CFF Evidence theme.
- Preserves uncertainty as `cantTell`, `untested`, or `Inconclusive`.
- Emits human-readable output, canonical JSON, SARIF 2.1.0, and a CFF receipt.
- Produces stable rule identifiers and source locations suitable for CI and
  evidence aggregation.

HTML5Assay does not start a browser, apply fixes, unpack archives, install
plugins, inspect an unsupplied server response, or make an HTTP request.

## Requirements

- Node.js 24.19.0 LTS
- pnpm 10.34.5 through Corepack

Dependencies use exact versions and the committed lockfile.

## Develop

```text
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

## CLI

```text
html5assay check <path> --policy cff-web-strict --format pretty
html5assay check <path> --manifest page-manifest.json --format json
html5assay check <path> --format sarif
html5assay catalog [rule-id] --format pretty|json
html5assay explain <rule-id>
html5assay verify-receipt <receipt.json>
```

Exit codes are `0` for `Pass`, `1` for `Fail`, `2` for `Inconclusive`, and `3`
for `ToolFailure` or invalid CLI use.

## Library

```ts
import { analyze, canonicalJson, toSarif } from '@canonflow/html5-assay';

const result = await analyze({
  root: '/absolute/input/root',
  entries: ['index.html'],
  manifest: 'page-manifest.json',
  policy: { id: 'cff-web-strict' }
});

process.stdout.write(canonicalJson(result));
const sarif = toSarif(result);
```

The API returns pure data. Canonical results exclude time, randomness, process
identifiers, locale-dependent text, and machine-specific paths.

## Verdicts

The run verdict priority is:

```text
ToolFailure > Fail > Inconclusive > Pass
```

Atomic outcomes are `passed`, `failed`, `inapplicable`, `cantTell`, and
`untested`. Unknown required evidence never becomes `Pass`.

The built-in policies are:

- `cff-web-strict` for production, documentation, evidence, and playground
  pages;
- `cff-web-balanced` for migration and local exploration.

Both policies pin `reviewDate` to `2026-08-19`. Suppression expiry is compared
with that deterministic reviewed date, never the machine clock.

## Standards baseline

The rule catalogue is reviewed against the WHATWG HTML Living Standard snapshot
dated 2026-08-19, WCAG 2.2, WAI-ARIA 1.2, ARIA in HTML, ACT Rules Format 1.1,
CSS Color Adjustment Level 1, and SARIF 2.1.0. WCAG 3.0 is research metadata and
is not a release gate.

## Repository map

```text
src/api       public library API
src/cli       thin command adapter
src/parse     HTML and CSS parser adapters
src/graph     bounded local document and asset graph
src/rules     catalogue and atomic evaluators
src/policy    data-only policy loading
src/result    canonical result, verdict, and SARIF
src/receipt   CFF receipt projection and verification
rules         distributable rule catalogue
policies      reviewed built-in policy packs
schemas       public JSON schemas
theme         CFF Evidence 1.0.0 semantic tokens
playground    non-authoritative local specimen, excluded from the package
test          unit, integration, determinism, and adversarial tests
```

See [architecture](docs/architecture.md), [evidence model](docs/evidence-model.md),
[standards and limits](docs/standards-and-limits.md), and the
[release checklist](docs/release-checklist.md).

## Security

Please read [SECURITY.md](SECURITY.md). The most important boundary is simple:
input is inert evidence. HTML5Assay must never execute supplied scripts or fetch
supplied URLs.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
