import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { analyze } from '../api/analyze.js';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  Digest,
  FindingLevel,
  RunVerdict,
  SourceRange
} from '../api/model.js';
import { parseHtml } from '../parse/html.js';
import { rangeAt } from '../parse/location.js';
import { canonicalDigest, digest } from '../result/canonical.js';

export type HookedAssayId = 'typescriptassay' | 'javascriptassay' | 'steassay';

export interface HookedStageFinding {
  readonly assayId: HookedAssayId;
  readonly ruleId: string;
  readonly ruleVersion: '0.1.0';
  readonly level: FindingLevel;
  readonly outcome: 'failed' | 'cantTell';
  readonly path: string;
  readonly range: SourceRange;
  readonly message: string;
  readonly observed: string;
}

export interface HookedStageReport {
  readonly assayId: HookedAssayId;
  readonly version: '0.1.0';
  readonly engine: 'external-cli' | 'embedded-static';
  readonly verdict: RunVerdict;
  readonly authoritative: boolean;
  readonly observedUnits: number;
  readonly counts: {
    readonly blocking: number;
    readonly advisory: number;
    readonly inconclusive: number;
  };
  readonly findings: readonly HookedStageFinding[];
  readonly receiptDigest: Digest;
  readonly rawReceipt: unknown;
}

export interface CrossAssayChainResult {
  readonly schemaVersion: 'cff.assay.bundle.v1';
  readonly pipeline: readonly ['html5assay', 'typescriptassay', 'javascriptassay', 'steassay'];
  readonly verdict: RunVerdict;
  readonly html5: AnalyzeResult;
  readonly typescript: HookedStageReport;
  readonly javascript: HookedStageReport;
  readonly ste: HookedStageReport;
  readonly receipts: readonly [AnalyzeResult['receipt'], unknown, unknown, unknown];
}

const verdictPriority: Readonly<Record<RunVerdict, number>> = {
  Pass: 0,
  Inconclusive: 1,
  Fail: 2,
  ToolFailure: 3
};

export const combineChainVerdicts = (verdicts: readonly RunVerdict[]): RunVerdict => {
  let current: RunVerdict = 'Pass';
  for (const candidate of verdicts) {
    if (verdictPriority[candidate] > verdictPriority[current]) current = candidate;
  }
  return current;
};

interface ExtractedScriptUnit {
  readonly path: string;
  readonly source: string;
  readonly hostSource: string;
  readonly baseOffset: number;
}

interface ExtractedProseSection {
  readonly path: string;
  readonly tagName: string;
  readonly text: string;
  readonly range: SourceRange;
}

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

const extractHtmlUnits = async (
  request: AnalyzeRequest
): Promise<{
  readonly root: string;
  readonly scripts: readonly ExtractedScriptUnit[];
  readonly prose: readonly ExtractedProseSection[];
}> => {
  const root = await realpath(request.root);
  const scripts: ExtractedScriptUnit[] = [];
  const prose: ExtractedProseSection[] = [];
  const seenScripts = new Set<string>();
  const proseTags = new Set([
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'li',
    'caption',
    'th',
    'td',
    'summary',
    'figcaption'
  ]);

  for (const entry of request.entries) {
    const candidate = isAbsolute(entry) ? entry : resolve(root, entry);
    if (!inside(root, candidate)) continue;
    let source = '';
    try {
      source = await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    const relPath = relative(root, candidate).split(sep).join('/') || entry;
    const parsed = parseHtml(relPath, source);
    for (const element of parsed.elements) {
      if (element.tagName === 'script') {
        const src = element.attributes.src?.trim();
        if (src !== undefined && src !== '' && !/^(?:https?:)?\/\//iu.test(src)) {
          const cleanSrc = src.split(/[?#]/u, 1)[0] ?? '';
          const scriptCandidate = resolve(dirname(candidate), cleanSrc);
          if (inside(root, scriptCandidate)) {
            const scriptRel = relative(root, scriptCandidate).split(sep).join('/');
            if (!seenScripts.has(scriptRel)) {
              seenScripts.add(scriptRel);
              try {
                const scriptText = await readFile(scriptCandidate, 'utf8');
                scripts.push({
                  path: scriptRel,
                  source: scriptText,
                  hostSource: scriptText,
                  baseOffset: 0
                });
              } catch {
                /* missing local script is already reported by HTML5Assay graph */
              }
            }
          }
        } else if (element.text.trim() !== '') {
          const rawStart = source.indexOf('>', element.range.start.offset);
          const baseOffset = rawStart >= 0 ? rawStart + 1 : element.range.start.offset;
          scripts.push({
            path: relPath,
            source: element.text,
            hostSource: source,
            baseOffset
          });
          const prosePropertyPattern =
            /"(?:title|text|body|description|excerpt|supports|limits|qualification|stake|question|businessValue|measure|history|expected|current|gap|next|publicContext)"\s*:\s*"((?:[^"\\]|\\.)+)"/gu;
          for (const match of element.text.matchAll(prosePropertyPattern)) {
            const rawText = (match[1] ?? '')
              .replace(/\\"/gu, '"')
              .replace(/\\n/gu, ' ')
              .replace(/\s+/gu, ' ')
              .trim();
            if (rawText.split(/\s+/u).length >= 4) {
              const startOffset = baseOffset + (match.index ?? 0);
              const endOffset = startOffset + match[0].length;
              prose.push({
                path: relPath,
                tagName: 'p',
                text: rawText,
                range: rangeAt(source, startOffset, endOffset)
              });
            }
          }
        }
      } else if (proseTags.has(element.tagName)) {
        const cleaned = element.directText.replace(/\s+/gu, ' ').trim();
        if (cleaned.length > 0) {
          prose.push({
            path: relPath,
            tagName: element.tagName,
            text: cleaned,
            range: element.range
          });
        }
      }
    }
  }
  return { root, scripts, prose };
};

const resolveExternalCli = (
  envVar: string,
  relativeCandidates: readonly string[]
): string | null => {
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv.trim() !== '' && existsSync(fromEnv)) return fromEnv;
  for (const candidate of relativeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const evaluateEmbeddedTypeScriptSurface = (
  scripts: readonly ExtractedScriptUnit[]
): readonly HookedStageFinding[] => {
  const findings: HookedStageFinding[] = [];
  const rules: ReadonlyArray<{
    readonly ruleId: string;
    readonly level: FindingLevel;
    readonly outcome: 'failed' | 'cantTell';
    readonly pattern: RegExp;
    readonly message: string;
  }> = [
    {
      ruleId: 'TSA-DYNAMIC-001',
      level: 'blocking',
      outcome: 'failed',
      pattern: /\b(?:eval|Function)\s*\(/gu,
      message:
        'Dynamic code evaluation (eval or Function constructor) violates TypeScriptAssay safety boundaries.'
    },
    {
      ruleId: 'TSA-ESCAPE-001',
      level: 'blocking',
      outcome: 'failed',
      pattern: /\bas\s+any\b|@ts-ignore\b|@ts-nocheck\b/gu,
      message:
        'Type escape hatch (as any, @ts-ignore, or @ts-nocheck) bypasses sound TypeScript verification.'
    },
    {
      ruleId: 'TSA-DOM-001',
      level: 'advisory',
      outcome: 'cantTell',
      pattern: /\.\s*(?:innerHTML|outerHTML)\s*=|document\.write\s*\(/gu,
      message:
        'Direct HTML sink assignment detected in script surface; verify untrusted input is escaped.'
    },
    {
      ruleId: 'TSA-BOUNDARY-001',
      level: 'advisory',
      outcome: 'cantTell',
      pattern: /\b(?:JSON\.parse|localStorage\.getItem|sessionStorage\.getItem)\s*\(/gu,
      message:
        'External boundary read (JSON.parse or Web Storage) requires runtime decoder validation.'
    }
  ];

  for (const unit of scripts) {
    for (const rule of rules) {
      for (const match of unit.source.matchAll(rule.pattern)) {
        const startOffset = unit.baseOffset + (match.index ?? 0);
        const endOffset = startOffset + match[0].length;
        findings.push({
          assayId: 'typescriptassay',
          ruleId: rule.ruleId,
          ruleVersion: '0.1.0',
          level: rule.level,
          outcome: rule.outcome,
          path: unit.path,
          range: rangeAt(unit.hostSource, startOffset, endOffset),
          message: rule.message,
          observed: match[0].slice(0, 120)
        });
      }
    }
  }
  return findings;
};

const evaluateEmbeddedJavaScriptSurface = (
  scripts: readonly ExtractedScriptUnit[]
): readonly HookedStageFinding[] => {
  const findings: HookedStageFinding[] = [];
  const rules: ReadonlyArray<{
    readonly ruleId: string;
    readonly level: FindingLevel;
    readonly outcome: 'failed' | 'cantTell';
    readonly pattern: RegExp;
    readonly message: string;
  }> = [
    {
      ruleId: 'JSA-I01',
      level: 'advisory',
      outcome: 'failed',
      pattern: /\bvar\s+[A-Za-z_$][\w$]*/gu,
      message: 'JSA-I01: var declaration observed; prefer const or scoped bindings.'
    },
    {
      ruleId: 'JSA-D01',
      level: 'advisory',
      outcome: 'cantTell',
      pattern: /\bthrow\s+new\s+Error\s*\(/gu,
      message: 'JSA-D01: exception throw statement observed; verify boundary error handling.'
    },
    {
      ruleId: 'JSA-E01',
      level: 'advisory',
      outcome: 'cantTell',
      pattern: /\b(?:fetch|setTimeout|setInterval|Math\.random|Date\.now)\s*\(/gu,
      message: 'JSA-E01: ambient effect call (fetch/timer/random/clock) observed in script surface.'
    },
    {
      ruleId: 'JSA-I02',
      level: 'advisory',
      outcome: 'cantTell',
      pattern: /\b(?:Object\.assign|Reflect\.set)\s*\(/gu,
      message: 'JSA-I02: object mutation helper observed in script surface.'
    }
  ];

  for (const unit of scripts) {
    for (const rule of rules) {
      for (const match of unit.source.matchAll(rule.pattern)) {
        const startOffset = unit.baseOffset + (match.index ?? 0);
        const endOffset = startOffset + match[0].length;
        findings.push({
          assayId: 'javascriptassay',
          ruleId: rule.ruleId,
          ruleVersion: '0.1.0',
          level: rule.level,
          outcome: rule.outcome,
          path: unit.path,
          range: rangeAt(unit.hostSource, startOffset, endOffset),
          message: rule.message,
          observed: match[0].slice(0, 120)
        });
      }
    }
  }
  return findings;
};

const runTypeScriptAssayHook = async (
  root: string,
  scripts: readonly ExtractedScriptUnit[]
): Promise<HookedStageReport> => {
  const tsCli = resolveExternalCli('HTML5ASSAY_TSASSAY_CLI', [
    '/home/arun/.local/state/canonflow/assay-worktrees/TypeScriptAssay/dist/src/cli.js',
    resolve(root, '../TypeScriptAssay/dist/src/cli.js')
  ]);
  const node20 = resolveExternalCli('HTML5ASSAY_NODE20_BIN', [
    '/home/arun/.local/state/canonflow/assay-documentation-audit/2026-11-24.4IXCiK/setup/node-v20.20.2-linux-x64/bin/node',
    process.execPath
  ]);

  const hasProjectTsAssay = existsSync(join(root, '.tsassay.json'));
  const scriptFindings = evaluateEmbeddedTypeScriptSurface(scripts);
  let externalReceipt: unknown = null;
  let externalVerdict: RunVerdict | null = null;
  let engine: 'external-cli' | 'embedded-static' = 'embedded-static';

  if (hasProjectTsAssay && tsCli !== null && node20 !== null) {
    const tempDir = await mkdtemp(join(tmpdir(), 'h5a-tsassay-'));
    try {
      const receiptPath = join(tempDir, 'ts-receipt.json');
      const run = spawnSync(node20, [tsCli, 'verify', root, '--json', receiptPath], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
      });
      if (existsSync(receiptPath)) {
        externalReceipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
        engine = 'external-cli';
        externalVerdict = run.status === 0 ? 'Pass' : run.status === 1 ? 'Fail' : 'Inconclusive';
      }
    } catch {
      /* fallback to embedded script-surface evidence */
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const blocking = scriptFindings.filter(
    (finding) => finding.level === 'blocking' && finding.outcome === 'failed'
  ).length;
  const advisory = scriptFindings.filter(
    (finding) => finding.level === 'advisory' && finding.outcome === 'failed'
  ).length;
  const inconclusive = scriptFindings.filter((finding) => finding.outcome === 'cantTell').length;

  const surfaceVerdict: RunVerdict =
    blocking > 0 ? 'Fail' : inconclusive > 0 ? 'Inconclusive' : 'Pass';
  const verdict =
    externalVerdict !== null
      ? combineChainVerdicts([externalVerdict, surfaceVerdict])
      : surfaceVerdict;

  const rawReceipt = externalReceipt ?? {
    schemaVersion: 'ts-assay-receipt/0.1',
    mode: 'html5assay-hooked-script-surface',
    verdict: {
      kind: verdict,
      reason:
        scripts.length === 0
          ? 'No embedded or linked local scripts were present in the HTML scope.'
          : `Analyzed ${scripts.length} script unit(s) from the HTML asset graph.`
    },
    observedScripts: scripts.length,
    counts: { blocking, advisory, inconclusive },
    findingsDigest: canonicalDigest(scriptFindings).value
  };

  return {
    assayId: 'typescriptassay',
    version: '0.1.0',
    engine,
    verdict,
    authoritative: engine === 'external-cli' && verdict === 'Pass',
    observedUnits: scripts.length,
    counts: { blocking, advisory, inconclusive },
    findings: scriptFindings,
    receiptDigest: canonicalDigest(rawReceipt),
    rawReceipt
  };
};

const runJavaScriptAssayHook = async (
  root: string,
  scripts: readonly ExtractedScriptUnit[]
): Promise<HookedStageReport> => {
  const jsCli = resolveExternalCli('HTML5ASSAY_JSASSAY_CLI', [
    '/home/arun/.local/state/canonflow/assay-worktrees/JavaScriptAssay/src/cli.js',
    resolve(root, '../JavaScriptAssay/src/cli.js')
  ]);
  const node20 = resolveExternalCli('HTML5ASSAY_NODE20_BIN', [
    '/home/arun/.local/state/canonflow/assay-documentation-audit/2026-11-24.4IXCiK/setup/node-v20.20.2-linux-x64/bin/node',
    process.execPath
  ]);

  const hasProjectJsAssay = existsSync(join(root, '.jsassay.json'));
  const scriptFindings = evaluateEmbeddedJavaScriptSurface(scripts);
  let externalReceipt: unknown = null;
  let externalVerdict: RunVerdict | null = null;
  let engine: 'external-cli' | 'embedded-static' = 'embedded-static';

  if (hasProjectJsAssay && jsCli !== null && node20 !== null) {
    const tempDir = await mkdtemp(join(tmpdir(), 'h5a-jsassay-'));
    try {
      const receiptPath = join(tempDir, 'js-receipt.json');
      const run = spawnSync(node20, [jsCli, 'verify', root, '--json', receiptPath], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
      });
      if (existsSync(receiptPath)) {
        externalReceipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
        engine = 'external-cli';
        externalVerdict = run.status === 0 ? 'Pass' : run.status === 1 ? 'Fail' : 'Inconclusive';
      }
    } catch {
      /* fallback to embedded script-surface evidence */
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const blocking = scriptFindings.filter(
    (finding) => finding.level === 'blocking' && finding.outcome === 'failed'
  ).length;
  const advisory = scriptFindings.filter(
    (finding) => finding.level === 'advisory' && finding.outcome === 'failed'
  ).length;
  const inconclusive = scriptFindings.filter((finding) => finding.outcome === 'cantTell').length;

  const surfaceVerdict: RunVerdict =
    blocking > 0 ? 'Fail' : inconclusive > 0 ? 'Inconclusive' : 'Pass';
  const verdict =
    externalVerdict !== null
      ? combineChainVerdicts([externalVerdict, surfaceVerdict])
      : surfaceVerdict;

  const rawReceipt = externalReceipt ?? {
    schemaVersion: 'js-assay-receipt/0.1',
    mode: 'html5assay-hooked-js-surface',
    verdict: {
      kind: verdict,
      reason:
        scripts.length === 0
          ? 'No embedded or linked local scripts were present in the HTML scope.'
          : `Analyzed ${scripts.length} JavaScript unit(s) from the HTML asset graph.`
    },
    observedScripts: scripts.length,
    counts: { blocking, advisory, inconclusive },
    findingsDigest: canonicalDigest(scriptFindings).value
  };

  return {
    assayId: 'javascriptassay',
    version: '0.1.0',
    engine,
    verdict,
    authoritative: engine === 'external-cli' && verdict === 'Pass',
    observedUnits: scripts.length,
    counts: { blocking, advisory, inconclusive },
    findings: scriptFindings,
    receiptDigest: canonicalDigest(rawReceipt),
    rawReceipt
  };
};

const splitSentences = (text: string): readonly string[] =>
  text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

const countWords = (sentence: string): number =>
  sentence
    .split(/\s+/u)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, ''))
    .filter((token) => token.length > 0).length;

const evaluateSteProse = (
  prose: readonly ExtractedProseSection[]
): readonly HookedStageFinding[] => {
  const findings: HookedStageFinding[] = [];
  const bannedTerms = new Set(['obviously', 'clearly', 'simply', 'just', 'very', 'basically']);
  const passivePattern = /\b(?:is|are|was|were|be|been|being)\s+[a-z]+ed\b/iu;
  const modalPattern = /\b(?:might|could|should|may)\b/iu;

  for (const section of prose) {
    const sentences = splitSentences(section.text);
    for (const sentence of sentences) {
      const words = countWords(sentence);
      if (words > 25) {
        findings.push({
          assayId: 'steassay',
          ruleId: 'STE-S01',
          ruleVersion: '0.1.0',
          level: 'blocking',
          outcome: 'failed',
          path: section.path,
          range: section.range,
          message: `Sentence exceeds 25-word controlled technical writing limit (${words} words).`,
          observed: sentence.slice(0, 140)
        });
      }
      for (const rawWord of sentence.split(/\s+/u)) {
        const normalized = rawWord.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gu, '');
        if (bannedTerms.has(normalized)) {
          findings.push({
            assayId: 'steassay',
            ruleId: 'STE-S04',
            ruleVersion: '0.1.0',
            level: 'advisory',
            outcome: 'failed',
            path: section.path,
            range: section.range,
            message: `Uncontrolled intensifier or filler term "${normalized}" reduces technical precision.`,
            observed: sentence.slice(0, 140)
          });
        }
      }
      if (passivePattern.test(sentence)) {
        findings.push({
          assayId: 'steassay',
          ruleId: 'STE-S06',
          ruleVersion: '0.1.0',
          level: 'advisory',
          outcome: 'cantTell',
          path: section.path,
          range: section.range,
          message:
            'Passive-voice construction observed; verify whether an explicit actor improves clarity.',
          observed: sentence.slice(0, 140)
        });
      }
      if (modalPattern.test(sentence)) {
        findings.push({
          assayId: 'steassay',
          ruleId: 'STE-S09',
          ruleVersion: '0.1.0',
          level: 'advisory',
          outcome: 'cantTell',
          path: section.path,
          range: section.range,
          message:
            'Ambiguous modal verb (should/might/could/may) observed; distinguish obligation from possibility.',
          observed: sentence.slice(0, 140)
        });
      }
    }
  }
  return findings;
};

const runSteAssayHook = async (
  root: string,
  prose: readonly ExtractedProseSection[]
): Promise<HookedStageReport> => {
  const steCli = resolveExternalCli('HTML5ASSAY_STEASSAY_CLI', [
    '/home/arun/.local/state/canonflow/assay-worktrees/STEAssay/dist/src/cli.js',
    resolve(root, '../STEAssay/dist/src/cli.js')
  ]);
  const node20 = resolveExternalCli('HTML5ASSAY_NODE20_BIN', [
    '/home/arun/.local/state/canonflow/assay-documentation-audit/2026-11-24.4IXCiK/setup/node-v20.20.2-linux-x64/bin/node',
    process.execPath
  ]);

  const findings = evaluateSteProse(prose);
  let externalReceipt: unknown = null;
  let engine: 'external-cli' | 'embedded-static' = 'embedded-static';

  if (steCli !== null && node20 !== null && prose.length > 0) {
    const tempDir = await mkdtemp(join(tmpdir(), 'h5a-steassay-'));
    try {
      const mdLines = prose.map((item) =>
        /^h[1-6]$/iu.test(item.tagName)
          ? `${'#'.repeat(Number(item.tagName.slice(1)))} ${item.text}`
          : item.text
      );
      await writeFile(join(tempDir, 'extracted.md'), `${mdLines.join('\n\n')}\n`);
      await writeFile(
        join(tempDir, 'glossary.json'),
        JSON.stringify({
          abbreviations: {
            VERA: 'Versioned Evidence, Recall and Assurance',
            FAT: 'Factory Acceptance Test',
            SAT: 'Site Acceptance Test',
            BOM: 'Bill of Materials',
            PLC: 'Programmable Logic Controller',
            DCS: 'Distributed Control System',
            SCADA: 'Supervisory Control and Data Acquisition',
            HMI: 'Human-Machine Interface',
            AMC: 'Annual Maintenance Contract',
            HTML: 'HyperText Markup Language',
            CSS: 'Cascading Style Sheets',
            WCAG: 'Web Content Accessibility Guidelines',
            SHA: 'Secure Hash Algorithm',
            JSON: 'JavaScript Object Notation',
            PDF: 'Portable Document Format',
            CAD: 'Computer-Aided Design',
            ERP: 'Enterprise Resource Planning',
            UAE: 'United Arab Emirates',
            ISO: 'International Organization for Standardization',
            ABB: 'ASEA Brown Boveri',
            KPI: 'Key Performance Indicator',
            ROI: 'Return on Investment'
          }
        })
      );
      await writeFile(
        join(tempDir, 'vocabulary.json'),
        JSON.stringify({
          bannedTerms: ['obviously', 'basically'],
          deprecatedTerms: [{ term: 'whitelist', replacement: 'allow list' }],
          imperativeVerbs: ['open', 'select', 'review', 'check', 'compare', 'export', 'save'],
          terminology: []
        })
      );
      await writeFile(
        join(tempDir, '.steassay.json'),
        JSON.stringify({
          version: 2,
          profile: 'new',
          includeGlobs: ['extracted.md'],
          excludedGlobs: [],
          glossaryPath: 'glossary.json',
          vocabularyPath: 'vocabulary.json',
          requiredCommands: [],
          rules: {
            'STE-S01': { maxWords: 25 },
            'STE-S09': { markers: ['requirement'], modals: ['must', 'shall'] }
          },
          baseline: []
        })
      );
      spawnSync(node20, [steCli, 'scan', tempDir], {
        cwd: tempDir,
        encoding: 'utf8',
        timeout: 20_000
      });
      const receiptCandidate = join(tempDir, '.ste-assay', 'receipt.json');
      if (existsSync(receiptCandidate)) {
        externalReceipt = JSON.parse(await readFile(receiptCandidate, 'utf8')) as unknown;
        engine = 'external-cli';
      }
    } catch {
      /* fallback to embedded STE evaluator */
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const blocking = findings.filter(
    (finding) => finding.level === 'blocking' && finding.outcome === 'failed'
  ).length;
  const advisory = findings.filter(
    (finding) => finding.level === 'advisory' && finding.outcome === 'failed'
  ).length;
  const inconclusive = findings.filter((finding) => finding.outcome === 'cantTell').length;

  const verdict: RunVerdict =
    blocking > 0 ? 'Fail' : prose.length === 0 || inconclusive > 0 ? 'Inconclusive' : 'Pass';

  const rawReceipt = externalReceipt ?? {
    schemaVersion: 1,
    command: 'html5assay-hooked-ste-scan',
    verdict,
    observedSections: prose.length,
    counts: { blocking, advisory, inconclusive },
    findingsDigest: canonicalDigest(findings).value
  };

  return {
    assayId: 'steassay',
    version: '0.1.0',
    engine,
    verdict,
    authoritative: false,
    observedUnits: prose.length,
    counts: { blocking, advisory, inconclusive },
    findings,
    receiptDigest: canonicalDigest(rawReceipt),
    rawReceipt
  };
};

export const analyzeChain = async (request: AnalyzeRequest): Promise<CrossAssayChainResult> => {
  const html5 = await analyze(request);
  let scripts: readonly ExtractedScriptUnit[] = [];
  let prose: readonly ExtractedProseSection[] = [];
  let root = request.root;
  try {
    const metadata = await stat(resolve(request.root));
    if (metadata.isDirectory()) {
      const extracted = await extractHtmlUnits(request);
      root = extracted.root;
      scripts = extracted.scripts;
      prose = extracted.prose;
    }
  } catch {
    /* handled by html5 result */
  }

  const skippedStage = (assayId: HookedAssayId): HookedStageReport => ({
    assayId,
    version: '0.1.0',
    engine: 'embedded-static',
    verdict: 'Inconclusive',
    authoritative: false,
    observedUnits: 0,
    counts: { blocking: 0, advisory: 0, inconclusive: 0 },
    findings: [],
    receiptDigest: digest('skipped-due-to-html5-tool-failure'),
    rawReceipt: { skipped: true }
  });

  const typescript =
    html5.verdict === 'ToolFailure'
      ? skippedStage('typescriptassay')
      : await runTypeScriptAssayHook(root, scripts);

  const javascript =
    html5.verdict === 'ToolFailure'
      ? skippedStage('javascriptassay')
      : await runJavaScriptAssayHook(root, scripts);

  const ste =
    html5.verdict === 'ToolFailure' ? skippedStage('steassay') : await runSteAssayHook(root, prose);

  return {
    schemaVersion: 'cff.assay.bundle.v1',
    pipeline: ['html5assay', 'typescriptassay', 'javascriptassay', 'steassay'],
    verdict: combineChainVerdicts([
      html5.verdict,
      typescript.verdict,
      javascript.verdict,
      ste.verdict
    ]),
    html5,
    typescript,
    javascript,
    ste,
    receipts: [html5.receipt, typescript.rawReceipt, javascript.rawReceipt, ste.rawReceipt]
  };
};
