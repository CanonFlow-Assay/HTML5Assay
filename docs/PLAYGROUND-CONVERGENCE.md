# Playground convergence — phase 1

The HTML playground already keeps browser preview local, treats source specimens
as inert evidence and retains non-authoritative investigation results. The CLI's
declared local asset graph and canonical receipt remain the applicable boundary.

The next safe increment is manifest/schema validation at the preview boundary:
invalid or unknown local specimen input becomes a visible local result before it
reaches the renderer. Reuse the dependency-free review command and existing
preview tests. Do not execute supplied scripts, emulate a server/webhook, claim
browser preview is verification, or import C# serializer/time abstractions.

## Phase 2 specimen (`validatePreviewManifest` / `reviewPreviewManifest`)

Run the offline preview manifest schema validation tests:

```sh
node --test playground/investigation.test.mjs
```
