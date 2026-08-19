import type { AnalyzeResult, Finding } from '../api/model.js';
import { ruleCatalog } from '../rules/catalog.js';

const sarifLevel = (finding: Finding): 'error' | 'warning' | 'note' =>
  finding.suppression?.suppressed === true
    ? 'note'
    : finding.level === 'blocking'
      ? 'error'
      : 'warning';

export const toSarif = (result: AnalyzeResult): unknown => ({
  version: '2.1.0',
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  runs: [
    {
      tool: {
        driver: {
          name: 'HTML5Assay',
          semanticVersion: '0.1.0',
          informationUri: 'https://github.com/CanonFlow-Assay/HTML5Assay',
          rules: ruleCatalog.map((rule) => ({
            id: rule.id,
            name: rule.title,
            shortDescription: { text: rule.expectations[0] ?? rule.title },
            properties: {
              version: rule.version,
              authority: rule.authority,
              defaultLevel: rule.defaultLevel,
              standards: rule.standards
            }
          }))
        }
      },
      results: result.findings.map((finding) => ({
        ruleId: finding.ruleId,
        level: sarifLevel(finding),
        message: { text: finding.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: finding.path, uriBaseId: '%SRCROOT%' },
              region: {
                startLine: finding.range.start.line,
                startColumn: finding.range.start.column,
                endLine: finding.range.end.line,
                endColumn: finding.range.end.column,
                charOffset: finding.range.start.offset,
                charLength: Math.max(0, finding.range.end.offset - finding.range.start.offset)
              }
            }
          }
        ],
        partialFingerprints: { evidenceDigest: finding.evidenceDigest.value },
        suppressions:
          finding.suppression?.suppressed === true
            ? [
                {
                  kind: 'external',
                  status: 'accepted',
                  justification: `${finding.suppression.owner ?? ''}: ${finding.suppression.reason ?? ''} (expires ${finding.suppression.expires ?? ''})`
                }
              ]
            : undefined,
        properties: {
          ruleVersion: finding.ruleVersion,
          authority: finding.authority,
          certainty: finding.certainty,
          outcome: finding.outcome,
          expected: finding.expected,
          observed: finding.observed,
          remediation: finding.remediation,
          standards: finding.standards
        }
      }))
    }
  ]
});
