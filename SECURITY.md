# Security policy

## Supported versions

HTML5Assay is pre-release. Security fixes apply to the latest reviewed source
until a supported release table is published.

## Report a vulnerability

Use GitHub's private vulnerability-reporting flow for this repository. Do not
open a public issue containing an exploit, private input, credential, or an
outside-root file path.

Include the affected revision, operating system, Node version, minimal inert
fixture, observed behavior, and expected boundary. Remove secrets and personal
data.

## Security invariants

- Supplied HTML, CSS, manifests, policies, and receipts are untrusted data.
- Page scripts are never executed.
- Network resources are never fetched.
- Symlinks and references cannot escape the declared input root.
- Policy packs contain data only.
- Archives and executable plugins are out of scope.
- Resource limits bound files, bytes, nodes, CSS rules, depth, and findings.
- Canonical evidence does not expose absolute machine paths.

If a required parser or security boundary cannot complete safely, the result is
`ToolFailure` or `Inconclusive`; it is never silently promoted to `Pass`.
