# Release evidence

`0.1.0.json` maps every stable release-gate ID in the release checklist to its
evidence and required reviewer. A gate remains pending until its evidence is
bound to the exact candidate where required and the named reviewer records an
accepting decision.

Changing either the candidate Git commit or archive digest invalidates every
affected candidate-bound evidence item. Reviews and approvals do not carry to a
new candidate: replace the candidate identity, mark affected items invalidated,
and collect fresh evidence and review. External evidence is referenced by a
stable URL or artifact locator and digest; it is never silently replaced.

The record is deliberately incomplete during draft development. It is an
evidence index, not release approval, a signature, or authority to publish.
