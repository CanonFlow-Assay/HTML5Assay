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
`pnpm run release:evidence:check` enforces its schema and the status/evidence/
reviewer/candidate consistency rules.

## Post-candidate evidence-only changes

After `candidate.gitCommit` and `candidate.archiveSha256` are set, repository
changes are evidence-only only when every changed path is one of:

- `release-evidence/0.1.0.json`, for evidence locators, statuses, reviewer
  identities, decisions, and timestamps; or
- `release-evidence/artifacts/0.1.0/**`, for immutable evidence and review
  reports referenced by that record.

The candidate fields themselves are immutable during evidence-only updates.
Pull-request discussion, CI checks, and review decisions may also be recorded as
external locators without a repository path. Changes to workflows, validators,
schemas, dependencies, source, tests, documentation outside those paths, or any
published package input require a new candidate archive and invalidate affected
candidate-bound evidence. The final human review applies to the final commit,
including any evidence-only commits, while package acceptance remains bound to
the candidate commit and archive digest recorded in the evidence record.
