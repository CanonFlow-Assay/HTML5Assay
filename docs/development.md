# Development

Use Node.js 24.19.0 LTS from `.nvmrc` and the exact `pnpm@10.34.5`
`packageManager` pin. npm is not a supported repository package manager and is
therefore not declared as a package engine.

```text
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`verify` checks formatting, lint, types, tests, build output, and the public pack
manifest. Do not weaken an unknown result to make a fixture green. Fix the
evidence model or preserve `cantTell`.

## Adding or changing a rule

Update these items in one reviewed change:

1. stable rule metadata and version;
2. authority and standards mapping;
3. applicability, expectations, and assumptions;
4. passed, failed, and inapplicable executable specimens;
5. a `cantTell` specimen when evidence can be unknown;
6. evaluator logic with precise locations;
7. strict and balanced policy effects;
8. catalogue and determinism tests;
9. standards digest and change record when an authority changed.

Changing severity or an outcome is evidence-contract work. It requires review
even when the implementation diff is small.

## Security tests

Keep adversarial coverage for traversal, final and parent-directory symlinks,
missing assets, malformed HTML and CSS, invalid encoding, deep trees, size and
finding limits, remote URLs, CSS imports, source maps, and inert script content.
Untrusted CSS must always be parsed with PostCSS automatic source-map loading
disabled. `sourceMappingURL` remains inert evidence and must never cause a map
file to be read, even through absolute, encoded-traversal, or symlink paths.
