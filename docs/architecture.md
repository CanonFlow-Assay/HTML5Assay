# Architecture

HTML5Assay is library-first. The CLI parses arguments, calls the public API, and
serializes the returned data. Rule logic does not depend on terminal state.

## Pipeline

An analysis follows this order:

1. Resolve the input root and data-only policy.
2. Validate resource limits and path boundaries.
3. Hash original supplied bytes.
4. Decode text under the defined UTF-8 policy.
5. Parse HTML without resource loading or script execution.
6. Parse local CSS without evaluating external imports.
7. Build the normalized document and asset graph.
8. Run atomic rules.
9. Map outcomes through the selected policy.
10. Sort findings by path, offset, rule identifier, and evidence digest.
11. Emit canonical JSON, SARIF, and a CFF receipt.

## Trust boundaries

The request root is the filesystem authority boundary. Entry paths, manifest
roots, linked assets, deployment evidence, and every path reached through a
symlink are resolved and checked against the canonical root before bytes are
read. Archives are not unpacked.

Remote references in HTML and CSS remain inert evidence. HTML5Assay does not use
an HTTP client, browser, DOM runtime, JavaScript VM, or installable plugin model.

Resource limits are checked before expensive reads or parses where the operating
system exposes the required size. A safe limit produces incomplete evidence and
an `Inconclusive` result. A required parser failure produces `ToolFailure`.

## Determinism

Canonical data uses normalized relative paths and lexicographically ordered
object keys. Findings use an explicit stable order. Operational timestamps,
absolute machine paths, locale formatting, process IDs, and random values do not
enter the canonical result.

The receipt binds the subject, assay, ruleset, policy, optional manifest,
toolchain, findings, limits, and result digest. Human approval remains a separate
governance act.

## Standalone placement

The design described `packages/html5assay/` inside a future CanonFlow pnpm
monorepo. No such monorepo existed in the supplied workspace. The authorized
placement is the dedicated `CanonFlow-Assay/HTML5Assay` repository, matching the
organization's separate CSharpAssay, FSharpAssay, STEAssay, and TypeScriptAssay
repositories. This repository root is therefore the package root. It still uses
pnpm workspace metadata so a later reviewed move can preserve package behavior.
