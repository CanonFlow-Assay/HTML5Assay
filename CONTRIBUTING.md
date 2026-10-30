# Contributing

Thank you for improving HTML5Assay.

Before proposing a change, read the architecture, evidence model, development
guide, security policy, and code of conduct. Keep changes deterministic,
offline, and narrowly scoped.

Run:

```text
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

Rule changes must include executable outcome examples, exact source locations,
standards mappings with automation limits, and tests. Do not describe a
heuristic as a standards violation. Do not change unknown evidence to a pass.

Commits should explain the evidence-contract effect. Pull requests should call
out rule-version, severity, policy, schema, digest, or canonical-output changes.
Release, waiver, signature, and promotion decisions require human review.
