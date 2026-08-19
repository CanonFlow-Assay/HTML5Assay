# Standards snapshot

`standards-snapshot.json` pins the authority set reviewed for ruleset
`html5assay-core/1.0.0`. The authority-set digest is the CFF canonical JSON
SHA-256 of the `authorities` array only. The package also binds the complete
snapshot digest into its generated catalogue identity.

Changing an authority requires one reviewed change that updates the snapshot,
rule metadata, executable fixtures, generated catalogue, digest tests, and
change record.
