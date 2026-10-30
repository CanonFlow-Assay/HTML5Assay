# Source-preview investigations

This branch extends the existing locally cached `origin/feat/initial-html5assay` candidate; it does not merge or approve that candidate. The parser-based engine and historical release evidence remain separate.

```sh
node --test playground/investigation.test.mjs
node scripts/try-playground.mjs
# Optional fresh local report:
node scripts/try-playground.mjs artifacts/playground/<fresh-name>.json
python3 -m http.server 4305 --bind 127.0.0.1
# Open http://127.0.0.1:4305/playground/
```

The existing ten-rule browser preview is now a pure reusable module. The new review layer selects a concrete next inspection, retains the 48 untested rules, rejects changed source/policy and exhausted budgets, and never returns Pass for a clear subset. Seven real document fault controls remove/alter document structure and test corresponding observations.

Changing the editor, loading another specimen or changing the policy invalidates visible results and the displayed subject digest. An asynchronous hash result cannot overwrite a newer input. Supplied source is displayed as text; scripts and URLs are not executed or fetched.

Both policy selectors use the same conservative regex preview subset. Full policy behavior requires the parser-based library/CLI and its declared asset graph. The selector does not pretend to implement the complete balanced-policy semantics.

The complete local gate now passes using isolated official Node `24.19.0` and pnpm `10.34.5`: formatting, typed engine lint/typecheck, 99 engine/regression tests, generated-data/golden consistency, historical release-record consistency, packed consumer tests, and six additional native preview tests. Run `bash eng/qualify-playground.sh` with those tools on PATH. Package metadata and dependency lock are byte-identical to the existing reviewed candidate; new development commands are separate local files.

This is distinct from a fresh candidate archive qualification in the pinned network-denied browser container, three-OS execution, assistive-technology review and human approval. Existing release records retain their original candidate identity and cannot be transferred to this changed branch. Local consistency of a historical record is not new release acceptance. No accessibility certification, release or remote publication is implied.
