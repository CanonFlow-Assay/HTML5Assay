# Independent browser harness

This is a separate, non-authoritative browser evidence harness. It is not part
of the published package or the static finding history.

The runner requires an externally installed Playwright package and its reviewed
browser binaries. It starts a loopback-only static server, aborts every
non-loopback request, and exercises Chromium, Firefox, and WebKit at 320, 768,
1024, and 1440 CSS pixels. It records keyboard order, focus indication, 200%
zoom, reduced-motion and forced-colors media, horizontal overflow, native dialog
and popover behavior, and playground state recovery.

Each mode runs in an isolated browser context. The runner asserts complete
keyboard traversal and focus indication, loopback-only loading, horizontal
reflow, 200% text resize plus half-width zoom-equivalent reflow, reduced-motion
and forced-colors emulation, and real local dialog, popover, and persisted-state
flows from `qualification.html`. It writes failed assertions into the evidence
file and exits nonzero if any automated probe fails.

Run `pnpm test:browser-harness -- browser-evidence.json` in the isolated release
environment. The JSON output still requires human and assistive-technology
review; it never promotes a static result to Pass.
