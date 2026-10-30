import { reviewHTML, selectHTMLInvestigation } from './investigation.mjs';
import { specimens } from './specimens.mjs';

const byId = (id) => document.getElementById(id);

const source = byId('source');
const example = byId('example');
const policy = byId('policy');
const loadExample = byId('load-example');
const analyze = byId('analyze');
const status = byId('example-status');
const specimenIdentity = byId('specimen-identity');
const verdictCard = byId('verdict-card');
const verdictText = byId('verdict');
const verdictIcon = byId('verdict-icon');
const resultSummary = byId('result-summary');
const resultPolicy = byId('result-policy');
const subjectDigest = byId('subject-digest');
const findingsList = byId('findings');

for (const specimen of specimens) {
  const option = document.createElement('option');
  option.value = specimen.id;
  option.textContent = specimen.name;
  example.append(option);
}

function currentSpecimen() {
  return specimens.find((item) => item.id === example.value) ?? specimens[0];
}

function loadSelectedExample({ announce = true } = {}) {
  const specimen = currentSpecimen();
  source.value = specimen.input;
  invalidatePreview();
  policy.value = specimen.policy;
  specimenIdentity.textContent = `${specimen.purpose} Expected ${specimen.expectedVerdict}; specimen sha-256 ${specimen.digest}.`;
  if (announce)
    status.textContent = `Loaded bundled example: ${specimen.name}. Choose Analyze local text to inspect it.`;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function renderFinding(finding) {
  const item = document.createElement('li');
  item.className = 'finding';

  const identifier = document.createElement('p');
  identifier.className = 'finding-id';
  identifier.textContent = `html5assay-preview · ${finding.ruleId}`;

  const message = document.createElement('p');
  message.textContent = finding.message;

  const evidence = document.createElement('p');
  const code = document.createElement('code');
  code.textContent = finding.observed;
  evidence.append('Observed: ', code);

  const expected = document.createElement('p');
  expected.textContent = `Expected: ${finding.expected}`;

  item.append(identifier, message, evidence, expected);
  return item;
}

async function analyzeLocalText() {
  analyze.disabled = true;
  try {
    const text = source.value;
    const selectedPolicy = policy.value;
    const review = reviewHTML(text, selectedPolicy);
    const findings = review.findings;
    const digest = await sha256(text);
    if (source.value !== text || policy.value !== selectedPolicy) {
      invalidatePreview();
      return;
    }
    const verdict = review.verdict;

    verdictCard.dataset.verdict = verdict;
    verdictText.textContent = `Preview — ${verdict}`;
    verdictIcon.textContent = verdict === 'Fail' ? '×' : '?';
    resultSummary.textContent =
      findings.length === 0
        ? '0 blocking preview findings; 48 required catalogue rules remain untested.'
        : `${findings.length} blocking preview finding${findings.length === 1 ? '' : 's'}; 48 required catalogue rules remain untested.`;
    resultPolicy.textContent = selectedPolicy;
    const investigation = selectHTMLInvestigation(review, text, selectedPolicy, 1);
    byId('next-investigation').textContent = investigation.reason;
    subjectDigest.textContent = digest;

    findingsList.replaceChildren();
    if (findings.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'status-empty';
      empty.dataset.cffState = 'empty';
      empty.textContent =
        'The bundled preview subset found no blocking source defect. The full assay is still required.';
      findingsList.append(empty);
    } else {
      for (const finding of findings) findingsList.append(renderFinding(finding));
    }
    status.textContent = `Analysis complete. Preview verdict ${verdict} with ${findings.length} blocking findings.`;
    verdictText.focus?.();
  } catch {
    verdictCard.dataset.verdict = 'ToolFailure';
    verdictText.textContent = 'Preview — ToolFailure';
    resultSummary.textContent = 'Local preview could not complete. No current result is available.';
    byId('next-investigation').textContent = 'Repair the local preview before investigating.';
  } finally {
    analyze.disabled = false;
  }
}

example.addEventListener('change', () => {
  const specimen = currentSpecimen();
  specimenIdentity.textContent = specimen.purpose;
});
loadExample.addEventListener('click', () => loadSelectedExample());
analyze.addEventListener('click', () => void analyzeLocalText());

loadSelectedExample({ announce: false });

function invalidatePreview() {
  verdictCard.dataset.verdict = 'Inconclusive';
  verdictText.textContent = 'Not analyzed · input changed';
  verdictIcon.textContent = '?';
  resultPolicy.textContent = policy.value;
  resultSummary.textContent = 'Run Analyze local text to observe the current source and policy.';
  subjectDigest.textContent = 'Not available';
  findingsList.replaceChildren();
  byId('next-investigation').textContent = 'Context required: run a fresh local preview.';
}
source.addEventListener('input', invalidatePreview);
policy.addEventListener('change', invalidatePreview);
