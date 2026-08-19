# Release checklist

Version 0.1.0 is releasable only after every item is evidenced.

- [ ] Exact package dependencies and lockfile have security review.
- [ ] Packed package installs and runs with the network blocked.
- [ ] Library and CLI canonical results are byte-identical.
- [ ] Repeated runs are deterministic across Linux, Windows, and macOS.
- [ ] All 58 rules have executable passed, failed, and inapplicable examples.
- [ ] Every applicable rule has an executable `cantTell` example.
- [ ] Every standards mapping states its automation limit.
- [ ] JSON, SARIF, and CFF receipt golden tests pass.
- [ ] Traversal, symlink, malformed input, deep-tree, and limit tests pass.
- [ ] CFF Evidence token values and contrast pairs pass in light and dark modes.
- [ ] Forced-colors, reduced-motion, and 320-pixel browser evidence passes.
- [ ] Remote assets and telemetry fail under `cff-web-strict`.
- [ ] The playground uses bundled specimens and shows the exact trust label.
- [ ] The public package excludes playground source and unrelated files.
- [ ] TypeScriptAssay, STEAssay, and the CFF host accept emitted contracts.
- [ ] Independent tester and Judge reviews pass.
- [ ] Human keyboard, screen-reader, zoom, reflow, contrast, touch, content,
      captions, and cognitive-clarity review is complete.
- [ ] An authorized human explicitly approves release.

Unchecked human or browser items are not converted into automated passes.
