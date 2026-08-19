# Independent browser qualification harness

This harness is separate from the published package and never promotes a static
assay result. The release path is the manually dispatched
`browser-qualification.yml` workflow, bound to one full candidate Git commit and
one candidate `.tgz` SHA-256.

## Locked execution environment

`environment-lock.json` pins Playwright 1.62.1 and its package integrities,
Chromium revision 1234 (151.0.7922.34), Firefox revision 1538 (153.0), WebKit
revision 2336 (26.5), repository Node 20.20.2, pnpm 10.34.5, and the reviewed
Linux/amd64 Playwright container by immutable digest. The container digest locks
its runtime Node build, whose exact version is recorded from `process.version`
in each run. `pnpm run browser:lock:check` validates the repository lockfile and
installed metadata against that record.

Each browser context sets `serviceWorkers: "block"` and routes only loopback
requests. Browser qualification additionally runs the entire container with
Docker `--network none`; an active host TCP probe must confirm that external
networking is unavailable. Browser routing alone is not accepted as host-level
denial.

The runner exercises Chromium, Firefox, and WebKit at 320, 768, 1024, and 1440
CSS pixels in isolated default, 200%-text/half-width, reduced-motion, and
forced-colors contexts. It also verifies complete keyboard traversal, visible
focus, overflow, native dialog and popover behavior, and persisted-state
recovery. Qualification evidence must contain exactly 51 unique matrix results:
48 browser/viewport/mode results and one native-flow result for each browser.
Both the runner and the independent evidence verifier reject missing,
duplicated, or unexpected entries.

## Evidence

The evidence envelope records the candidate commit and archive digest,
Playwright version, locked and executable browser revisions, operating system,
Node version, execution timestamps and duration, network controls, result,
failures, and a canonical SHA-256 evidence digest. Validate an artifact with:

```sh
pnpm run browser:evidence:verify -- browser-evidence.json
```

An automated Pass still requires the separate human and assistive-technology
review recorded in `release-evidence/0.1.0.json`. No candidate browser run is
performed merely by validating this harness contract.
