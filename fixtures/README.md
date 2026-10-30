# Adversarial fixtures

Each `*.fixture.json` file is inert data conforming to
`schemas/adversarial-fixture.schema.json`. A fixture declares an isolated file
tree, entry paths, a reviewed built-in policy plus optional tighter resource
limits, and observable result expectations.

The harness rejects absolute or parent-traversing fixture file names before it
writes the isolated tree. Fixture content is never executed and remote
references are never fetched. Add a fixture whenever a parser, containment,
resource-limit, or evidence-classification defect is fixed.
