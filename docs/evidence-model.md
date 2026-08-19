# Evidence model

HTML5Assay distinguishes a run verdict from an atomic rule outcome.

## Run verdict

- `Pass`: every applicable blocking rule passed and no required evidence is
  unknown.
- `Fail`: at least one unsuppressed blocking finding exists.
- `Inconclusive`: no blocking finding exists, but required evidence or complete
  analysis is unavailable.
- `ToolFailure`: the assay could not complete its defined procedure.

Priority is `ToolFailure > Fail > Inconclusive > Pass`.

## Atomic outcomes

- `passed`
- `failed`
- `inapplicable`
- `cantTell`
- `untested`

These outcomes follow the ACT Rules Format vocabulary. A heuristic is never
presented as a proven standards violation. Passing an automated subset is never
presented as complete WCAG conformance.

## Findings

Each finding records rule identity and version, authority, effective level,
certainty, normalized path and source range, observed evidence, expected
condition, remediation, standards mappings, evidence digest, and optional
suppression state.

Findings sort by normalized path, start offset, rule identifier, and evidence
digest. This ordering is part of the public deterministic contract.

## Suppressions

A suppression is data, not executable policy. It requires an owner, reason,
expiry date, and rule identifier. Optional path scope narrows the record.
Suppression expiry is evaluated against the policy pack's pinned `reviewDate`,
not wall-clock time. A suppression does not alter the underlying atomic outcome
or make evidence authoritative.

## Receipts

A CFF receipt binds immutable evidence identities. Verification checks the
receipt schema, identities, digests, verdict vocabulary, limits, authority
limitations, and the explicit human-approval requirement. Receipt verification
does not approve, sign, waive, release, or promote a result.
