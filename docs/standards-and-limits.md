# Standards and automation limits

The standards snapshot was reviewed on 2026-08-19.

| Area          | Authority                                     | Scope                                                                                              |
| ------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| HTML          | WHATWG HTML Living Standard reviewed snapshot | Syntax, elements, attributes, content models, and author requirements that static source can prove |
| Accessibility | WCAG 2.2 Level AA target                      | Only success criteria mapped by individual automated rules                                         |
| ARIA          | WAI-ARIA 1.2 and ARIA in HTML                 | Static role, state, property, host, and ownership evidence                                         |
| Test form     | ACT Rules Format 1.1                          | Atomic applicability, expectations, assumptions, examples, and outcomes                            |
| Adaptation    | CSS Color Adjustment Level 1                  | Static color-scheme and forced-colors evidence                                                     |
| Results       | SARIF 2.1.0 and CFF result schemas            | Stable findings, locations, evidence, and digests                                                  |

WCAG 3.0 is a working draft and is not a release gate.

## Default resource limits

| Resource                   |   Limit |
| -------------------------- | ------: |
| Input files                |  10,000 |
| One HTML or CSS file       |   4 MiB |
| Total analyzed bytes       |  64 MiB |
| HTML nodes per document    | 250,000 |
| CSS rules per page graph   | 100,000 |
| Local reference depth      |      32 |
| Findings before truncation |  20,000 |

The default initial-page-graph budget is 750 KiB. A playground with bundled
analyzers may use 2 MiB.

## What static analysis cannot prove

Source inspection cannot by itself prove rendered contrast under every cascade,
320 CSS-pixel reflow, focus visibility, target spacing, motion behavior,
assistive-technology output, alternative-text meaning, caption quality,
interaction recovery, or complete WCAG conformance. When bounded static evidence
does not decide a requirement, the outcome is `cantTell` and a required check
makes the run `Inconclusive`.

Production release also requires the separate network-blocked browser harness
and human accessibility review described in the release checklist.
