# HTML5Assay core ruleset

The distributable core catalogue is exposed by the library and by
`html5assay catalog --format json`. Its immutable identity is
`html5assay-core/1.0.0`; its digest is calculated from canonical catalogue
JSON. Every entry includes explicit applicability, expectations, assumptions,
standards mappings with automation limits, and passed, failed, and
inapplicable examples. Rules that can lack required source evidence also have
a `cantTell` example.

Rule implementations live in `src/rules`. This directory is intentionally
data-only in the published package: it contains no executable plugin hook.
