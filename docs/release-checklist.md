# Release checklist

Version 0.1.0 is releasable only after every item is evidenced in
`release-evidence/0.1.0.json` and accepted by its named reviewer role.

- [ ] **RG-01** — Bind the release candidate to an exact Git commit and one candidate archive SHA-256.
- [ ] **RG-02** — Invalidate affected candidate-bound evidence whenever the candidate commit or archive changes.
- [ ] **RG-03** — Complete dependency and lockfile security review.
- [ ] **RG-04** — Complete workflow-action security review; every action reference is a reviewed full commit SHA.
- [ ] **RG-05** — Complete candidate package security review against the bound archive digest.
- [ ] **RG-06** — Install and run the packed package with external networking denied.
- [ ] **RG-07** — Prove library and CLI canonical results are byte-identical.
- [ ] **RG-08** — Prove repeated results are deterministic on Linux, Windows, and macOS.
- [ ] **RG-09** — Execute passed, failed, and inapplicable examples for all 58 rules.
- [ ] **RG-10** — Execute a `cantTell` example for every rule that can lack evidence.
- [ ] **RG-11** — Confirm every standards mapping states its automation limit.
- [ ] **RG-12** — Pass reviewed JSON, SARIF, and CFF receipt golden tests.
- [ ] **RG-13** — Pass traversal, symlink, malformed-input, deep-tree, and resource-limit tests.
- [ ] **RG-14** — Pass CFF Evidence token and contrast checks in light and dark modes.
- [ ] **RG-15** — Pass the host-network-denied Chromium, Firefox, and WebKit matrix at all required viewports and modes.
- [ ] **RG-16** — Prove remote assets and telemetry fail under `cff-web-strict`.
- [ ] **RG-17** — Confirm the playground uses bundled specimens and the exact trust label.
- [ ] **RG-18** — Confirm the public package excludes playground source and unrelated files.
- [ ] **RG-19** — Obtain TypeScriptAssay, STEAssay, and CFF-host acceptance for the same candidate digest.
- [ ] **RG-20** — Obtain independent tester and LLM-judge review of the candidate evidence.
- [ ] **RG-21** — Complete scoped human and assistive-technology review using the WCAG-EM 2.0 report format.
- [ ] **RG-22** — Obtain an approving authorized human review on the final candidate commit.
- [ ] **RG-23** — Merge only after approval, then verify trusted-main CI for the merged commit.
- [ ] **RG-24** — Publish only through the approved release procedure and only from the approved digest.

Unchecked human, browser, security, companion, or release items are never converted into automated passes.
