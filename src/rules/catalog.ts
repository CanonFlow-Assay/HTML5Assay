import type {
  Authority,
  FindingLevel,
  RuleDefinition,
  RuleExample,
  StandardsMapping
} from '../api/model.js';
import { canonicalDigest } from '../result/canonical.js';

interface RuleSeed {
  readonly id: string;
  readonly title: string;
  readonly requirement: string;
  readonly passed: string;
  readonly failed: string;
  readonly inapplicable: string;
}

const themeContractExample = `:root{color-scheme:light dark;--cf-bg:#f7f9fb;--cf-surface:#ffffff;--cf-surface-raised:#eef3f8;--cf-glass:rgba(255, 255, 255, 0.86);--cf-text:#17202a;--cf-text-muted:#4f5d6b;--cf-outline:#667487;--cf-scrim:rgba(23, 32, 42, 0.36);--cf-primary:#005ea8;--cf-on-primary:#ffffff;--cf-primary-container:#d6eaff;--cf-on-primary-container:#002f52;--cf-secondary:#00696f;--cf-on-secondary:#ffffff;--cf-secondary-container:#c8f2f3;--cf-on-secondary-container:#003638;--cf-tertiary:#6546a3;--cf-on-tertiary:#ffffff;--cf-tertiary-container:#e9dfff;--cf-on-tertiary-container:#271451;--cf-pass:#176b3a;--cf-check:#7a4d00;--cf-fail:#b4232c;--cf-focus:#005fcc}@media(prefers-color-scheme:dark){:root{--cf-bg:#0b0f14;--cf-surface:#121922;--cf-surface-raised:#182231;--cf-glass:rgba(18, 25, 34, 0.84);--cf-text:#f2f6fa;--cf-text-muted:#b7c1cc;--cf-outline:#748398;--cf-scrim:rgba(0, 0, 0, 0.64);--cf-primary:#8fc7ff;--cf-on-primary:#002f52;--cf-primary-container:#0b3d68;--cf-on-primary-container:#d6ebff;--cf-secondary:#68d5d8;--cf-on-secondary:#003738;--cf-secondary-container:#114b4e;--cf-on-secondary-container:#c4f4f4;--cf-tertiary:#c8b7ff;--cf-on-tertiary:#30205f;--cf-tertiary-container:#45377a;--cf-on-tertiary-container:#e9e1ff;--cf-pass:#71d79c;--cf-check:#ffd166;--cf-fail:#ff8a95;--cf-focus:#ffbf47}}`;

const seeds: readonly RuleSeed[] = [
  {
    id: 'H5A-DOC-001',
    title: 'Short HTML doctype',
    requirement: 'A full document starts with <!doctype html>.',
    passed: '<!doctype html><html lang="en"><title>Page</title></html>',
    failed: '<html lang="en"><title>Page</title></html>',
    inapplicable: '<p>Manifest-declared fragment</p>'
  },
  {
    id: 'H5A-DOC-002',
    title: 'Document language',
    requirement: 'The root html element has a non-empty, structurally valid language tag.',
    passed: '<html lang="en-GB"><title>Page</title></html>',
    failed: '<html lang="not_a_tag"><title>Page</title></html>',
    inapplicable: '<p>Fragment language comes from its host.</p>'
  },
  {
    id: 'H5A-DOC-003',
    title: 'Page title',
    requirement: 'A full document has exactly one non-empty title.',
    passed: '<title>Rule catalogue — HTML5Assay</title>',
    failed: '<title> </title>',
    inapplicable: '<p>A fragment does not own a document title.</p>'
  },
  {
    id: 'H5A-DOC-004',
    title: 'Unique identifiers',
    requirement: 'Every id value is unique in its document.',
    passed: '<p id="first">A</p><p id="second">B</p>',
    failed: '<p id="same">A</p><p id="same">B</p>',
    inapplicable: '<p>No identifiers.</p>'
  },
  {
    id: 'H5A-DOC-005',
    title: 'Conforming syntax surface',
    requirement: 'Parsed elements and attributes have no statically provable conformance error.',
    passed: '<!doctype html><html lang="en"><title>Page</title><p class="note">Text</p></html>',
    failed: '<input type="wat">',
    inapplicable: '<!-- empty fragment -->'
  },
  {
    id: 'H5A-DOC-006',
    title: 'No obsolete features',
    requirement: 'Obsolete-but-conforming elements and attributes are absent.',
    passed: '<strong>Important</strong>',
    failed: '<center>Centred text</center>',
    inapplicable: '<!-- no elements -->'
  },
  {
    id: 'H5A-DOC-007',
    title: 'Contained local references',
    requirement: 'Every resolved local reference stays inside the declared root.',
    passed: '<link rel="stylesheet" href="styles/site.css">',
    failed: '<link rel="stylesheet" href="../outside.css">',
    inapplicable: '<p>No resource references.</p>'
  },

  {
    id: 'H5A-SEM-001',
    title: 'One primary main landmark',
    requirement: 'Each full page exposes exactly one visible main landmark.',
    passed: '<main>Primary content</main>',
    failed: '<main>A</main><main>B</main>',
    inapplicable: '<p>Manifest-declared fragment</p>'
  },
  {
    id: 'H5A-SEM-002',
    title: 'Skip link reaches main',
    requirement: 'A same-page skip link targets the primary content.',
    passed: '<a href="#content">Skip to content</a><main id="content">Content</main>',
    failed: '<a href="#missing">Skip</a><main id="content">Content</main>',
    inapplicable: '<p>Manifest-declared fragment</p>'
  },
  {
    id: 'H5A-SEM-003',
    title: 'Clear heading hierarchy',
    requirement: 'Heading levels do not skip levels in document order.',
    passed: '<h1>Page</h1><h2>Section</h2>',
    failed: '<h1>Page</h1><h3>Section</h3>',
    inapplicable: '<p>No headings.</p>'
  },
  {
    id: 'H5A-SEM-004',
    title: 'Native interactive elements',
    requirement: 'Static button and link behavior uses native interactive elements.',
    passed: '<button type="button">Copy</button>',
    failed: '<div role="button" tabindex="0">Copy</div>',
    inapplicable: '<p>No interactive behavior.</p>'
  },
  {
    id: 'H5A-SEM-005',
    title: 'Link and button purpose',
    requirement: 'Links have navigable href values and buttons represent actions.',
    passed: '<a href="docs.html">Read docs</a><button>Copy</button>',
    failed: '<a href="#" role="button">Submit</a>',
    inapplicable: '<p>No links or buttons.</p>'
  },
  {
    id: 'H5A-SEM-006',
    title: 'Table structure',
    requirement:
      'Data tables identify headers and provide a caption when a title is declared necessary.',
    passed: '<table><caption>Builds</caption><tr><th>State</th></tr><tr><td>Pass</td></tr></table>',
    failed: '<table><tr><td>State</td></tr></table>',
    inapplicable: '<p>No data table.</p>'
  },
  {
    id: 'H5A-SEM-007',
    title: 'Unique landmark names',
    requirement: 'Repeated landmark types have distinct accessible names.',
    passed: '<nav aria-label="Primary"></nav><nav aria-label="Rule"></nav>',
    failed: '<nav aria-label="Primary"></nav><nav aria-label="Primary"></nav>',
    inapplicable: '<nav aria-label="Primary"></nav>'
  },

  {
    id: 'H5A-A11Y-001',
    title: 'Image text alternatives',
    requirement: 'Images explicitly declare alt text, including empty alt for decoration.',
    passed: '<img src="chart.png" alt="Build failures by day">',
    failed: '<img src="chart.png">',
    inapplicable: '<p>No images.</p>'
  },
  {
    id: 'H5A-A11Y-002',
    title: 'Named form controls',
    requirement: 'Every form control has a programmatically determinable name.',
    passed: '<label for="query">Search</label><input id="query">',
    failed: '<input id="query">',
    inapplicable: '<p>No form controls.</p>'
  },
  {
    id: 'H5A-A11Y-003',
    title: 'Named buttons and links',
    requirement: 'Buttons and links have a non-empty accessible name.',
    passed: '<button>Analyze</button><a href="docs.html">Docs</a>',
    failed: '<button><svg></svg></button>',
    inapplicable: '<p>No buttons or links.</p>'
  },
  {
    id: 'H5A-A11Y-004',
    title: 'Valid ARIA',
    requirement: 'ARIA roles, states, properties, and ownership use supported names and values.',
    passed: '<button aria-expanded="false">Rules</button>',
    failed: '<button aria-expanded="maybe">Rules</button>',
    inapplicable: '<button>Rules</button>'
  },
  {
    id: 'H5A-A11Y-005',
    title: 'Native semantics preserved',
    requirement: 'ARIA does not conflict with strong native semantics.',
    passed: '<button type="button" role="button">Copy</button>',
    failed: '<button role="heading">Copy</button>',
    inapplicable: '<div>Static text</div>'
  },
  {
    id: 'H5A-A11Y-006',
    title: 'No positive tabindex',
    requirement: 'Positive tabindex values are absent.',
    passed: '<button tabindex="0">Copy</button>',
    failed: '<button tabindex="2">Copy</button>',
    inapplicable: '<p>No tabindex.</p>'
  },
  {
    id: 'H5A-A11Y-007',
    title: 'No global focus shortcuts',
    requirement: 'autofocus and accesskey are absent without a reviewed exception.',
    passed: '<input aria-label="Search">',
    failed: '<input autofocus accesskey="s" aria-label="Search">',
    inapplicable: '<p>No controls.</p>'
  },
  {
    id: 'H5A-A11Y-008',
    title: 'Media text tracks',
    requirement: 'Audio and video declare local caption or transcript evidence.',
    passed: '<video><track kind="captions" src="captions.vtt"></video>',
    failed: '<video src="talk.mp4" controls></video>',
    inapplicable: '<p>No timed media.</p>'
  },
  {
    id: 'H5A-A11Y-009',
    title: 'Status message pattern',
    requirement: 'Declared status messages use status or a suitable polite live region.',
    passed: '<output role="status">Copied</output>',
    failed: '<div class="status">Copied</div>',
    inapplicable: '<p>No status message marker.</p>'
  },

  {
    id: 'H5A-CSS-001',
    title: 'Visible focus styles',
    requirement: 'CSS does not remove focus indicators without a provable replacement.',
    passed: '<style>:focus{outline:2px solid CanvasText}</style>',
    failed: '<style>:focus{outline:none}</style>',
    inapplicable: '<p>No authored focus CSS.</p>'
  },
  {
    id: 'H5A-CSS-002',
    title: 'Status beyond color',
    requirement: 'Status declarations have visible text or icon evidence in addition to color.',
    passed: '<span class="pass-status">✓ Pass</span>',
    failed: '<i class="pass-status green-dot" aria-label="Pass"></i>',
    inapplicable: '<p>No status marker.</p>'
  },
  {
    id: 'H5A-CSS-003',
    title: 'Text contrast',
    requirement: 'Statically resolvable foreground/background pairs reach WCAG AA contrast.',
    passed: '<style>p{color:#17202a;background:#fff}</style><p>Text</p>',
    failed: '<style>p{color:#aaa;background:#fff}</style><p>Text</p>',
    inapplicable: '<p>No resolvable authored color pair.</p>'
  },
  {
    id: 'H5A-CSS-004',
    title: 'Non-text contrast',
    requirement: 'Resolvable controls and focus indicators reach 3:1 against adjacent colors.',
    passed: '<style>button{border:2px solid #333;background:#fff}</style><button>Go</button>',
    failed: '<style>button{border:1px solid #ddd;background:#fff}</style><button>Go</button>',
    inapplicable: '<p>No resolvable control pair.</p>'
  },
  {
    id: 'H5A-CSS-005',
    title: 'Target size',
    requirement: 'Essential controls meet 24 by 24 CSS pixels or a defined spacing exception.',
    passed: '<style>button{min-width:24px;min-height:24px}</style><button>Go</button>',
    failed: '<style>button{width:16px;height:16px}</style><button>Go</button>',
    inapplicable: '<p>No essential controls.</p>'
  },
  {
    id: 'H5A-CSS-006',
    title: 'Reduced motion',
    requirement: 'Non-essential animations have a prefers-reduced-motion alternative.',
    passed:
      '<style>.x{animation:pulse 1s}@media (prefers-reduced-motion:reduce){.x{animation:none}}</style>',
    failed: '<style>.x{animation:pulse 1s infinite}</style>',
    inapplicable: '<p>No animation or transition.</p>'
  },
  {
    id: 'H5A-CSS-007',
    title: 'Forced-colors resilience',
    requirement: 'Authored focus, boundary, and status styles include forced-colors support.',
    passed: '<style>@media (forced-colors:active){button{border:1px solid ButtonText}}</style>',
    failed: '<style>button{forced-color-adjust:none}</style>',
    inapplicable: '<p>No custom control or status styling.</p>'
  },
  {
    id: 'H5A-CSS-008',
    title: 'Reflow',
    requirement: 'Source evidence does not force two-dimensional scrolling at 320 CSS pixels.',
    passed: '<style>main{max-width:100%;overflow-wrap:anywhere}</style>',
    failed: '<style>main{min-width:1200px}</style>',
    inapplicable: '<p>No authored layout dimensions.</p>'
  },
  {
    id: 'H5A-CSS-009',
    title: 'Logical properties',
    requirement: 'Direction-sensitive component layout uses logical properties.',
    passed: '<style>.card{margin-inline-start:1rem}</style>',
    failed: '<style>.card{margin-left:1rem}</style>',
    inapplicable: '<p>No direction-sensitive CSS.</p>'
  },
  {
    id: 'H5A-CSS-010',
    title: 'Container-aware components',
    requirement: 'Components whose layout depends on their container use container-query evidence.',
    passed:
      '<style>.list{container-type:inline-size}@container (min-width:30rem){.item{display:grid}}</style>',
    failed:
      '<section data-container-adaptive><style>@media (min-width:30rem){.item{display:grid}}</style></section>',
    inapplicable: '<p>No marked adaptive component.</p>'
  },

  {
    id: 'H5A-SAFE-001',
    title: 'No remote runtime dependency',
    requirement: 'Production CFF pages reference no remote runtime asset.',
    passed: '<script src="assets/app.js" defer></script>',
    failed: '<script src="https://cdn.example/app.js"></script>',
    inapplicable: '<p>No runtime assets.</p>'
  },
  {
    id: 'H5A-SAFE-002',
    title: 'No inline event handlers',
    requirement: 'Inline event-handler attributes are absent.',
    passed: '<button id="copy">Copy</button>',
    failed: '<button onclick="copy()">Copy</button>',
    inapplicable: '<p>No event-capable elements.</p>'
  },
  {
    id: 'H5A-SAFE-003',
    title: 'Safe new browsing contexts',
    requirement: 'target=_blank links include noopener or noreferrer.',
    passed: '<a href="docs.html" target="_blank" rel="noopener">Docs</a>',
    failed: '<a href="docs.html" target="_blank">Docs</a>',
    inapplicable: '<a href="docs.html">Docs</a>'
  },
  {
    id: 'H5A-SAFE-004',
    title: 'Declared local form actions',
    requirement: 'Form actions are local and permitted by policy.',
    passed: '<form action="/search"><button>Search</button></form>',
    failed: '<form action="https://collector.example"><button>Send</button></form>',
    inapplicable: '<p>No forms.</p>'
  },
  {
    id: 'H5A-SAFE-005',
    title: 'No tracking references',
    requirement: 'Analytics, telemetry, fingerprinting, and advertising references are absent.',
    passed: '<script src="assets/app.js" defer></script>',
    failed: '<script src="analytics.js"></script>',
    inapplicable: '<p>No scripts or tracking pixels.</p>'
  },
  {
    id: 'H5A-SAFE-006',
    title: 'Restrictive CSP evidence',
    requirement: 'A supplied deployment manifest declares a restrictive Content-Security-Policy.',
    passed: '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">',
    failed: '<meta http-equiv="Content-Security-Policy" content="default-src *">',
    inapplicable: '<p>Fragment does not declare deployment headers.</p>'
  },

  {
    id: 'H5A-CFF-001',
    title: 'Shared page shell',
    requirement: 'A CFF page has header, primary navigation, main, and footer.',
    passed: '<header></header><nav aria-label="Primary"></nav><main></main><footer></footer>',
    failed: '<main>Only content</main>',
    inapplicable: '<p>Non-CFF fragment.</p>'
  },
  {
    id: 'H5A-CFF-002',
    title: 'Product identity terms',
    requirement: 'CFF identity exposes product name, version, status, and authority label.',
    passed:
      '<header>HTML5Assay · Version 0.1.0 · Specified · Static source evidence authority</header>',
    failed: '<header>HTML5Assay</header>',
    inapplicable: '<p>Non-CFF fragment.</p>'
  },
  {
    id: 'H5A-CFF-003',
    title: 'Playground trust label',
    requirement: 'A playground states Preview only — non-authoritative next to result status.',
    passed:
      '<main data-page-kind="playground"><output>Pass</output><p>Preview only — non-authoritative</p></main>',
    failed: '<main data-page-kind="playground"><output>Pass</output></main>',
    inapplicable: '<main data-page-kind="documentation"></main>'
  },
  {
    id: 'H5A-CFF-004',
    title: 'Result identity and counts',
    requirement: 'A result page exposes verdict, three counts, policy, and evidence identity.',
    passed:
      '<main><h1>Pass</h1><p>0 blocking · 0 advisory · 0 inconclusive</p><p>Policy: cff-web-strict</p><p>Evidence digest: sha-256</p></main>',
    failed: '<main><h1>Pass</h1></main>',
    inapplicable: '<main>Overview</main>'
  },
  {
    id: 'H5A-CFF-005',
    title: 'Finding identity',
    requirement: 'Every displayed finding identifies its assay and rule.',
    passed: '<article data-finding data-assay="html5assay" data-rule-id="H5A-DOC-001"></article>',
    failed: '<article data-finding>Missing identity</article>',
    inapplicable: '<p>No displayed findings.</p>'
  },
  {
    id: 'H5A-CFF-006',
    title: 'Shared page states',
    requirement: 'Empty, loading, error, and unavailable content uses shared state markup.',
    passed: '<section data-cff-state="empty"><h2>No findings</h2></section>',
    failed: '<div class="error">Oops</div>',
    inapplicable: '<p>Content is available.</p>'
  },
  {
    id: 'H5A-CFF-007',
    title: 'Non-color status',
    requirement: 'CFF status exposes exact status text and an icon or equivalent shape.',
    passed: '<strong data-status="Fail"><span aria-hidden="true">×</span> Fail</strong>',
    failed: '<span class="fail-status red-dot" aria-label="Fail"></span>',
    inapplicable: '<p>No status.</p>'
  },

  {
    id: 'H5A-PERF-001',
    title: 'Initial graph byte budget',
    requirement: 'Raw local initial graph bytes stay within the page-kind budget.',
    passed: '<link rel="stylesheet" href="small.css">',
    failed: '<script src="oversize.js" defer></script>',
    inapplicable: '<p>Fragment budget belongs to its host.</p>'
  },
  {
    id: 'H5A-PERF-002',
    title: 'Intrinsic image dimensions',
    requirement: 'Images declare intrinsic dimensions or have a provable stable aspect ratio.',
    passed: '<img src="mark.png" alt="" width="40" height="40">',
    failed: '<img src="mark.png" alt="">',
    inapplicable: '<p>No images.</p>'
  },
  {
    id: 'H5A-PERF-003',
    title: 'Appropriate lazy loading',
    requirement: 'Below-fold images may be lazy while likely principal images are eager.',
    passed:
      '<img src="hero.png" alt="Evidence overview" fetchpriority="high"><img src="detail.png" alt="Detail" loading="lazy">',
    failed: '<img src="hero.png" alt="Evidence overview" loading="lazy">',
    inapplicable: '<p>No images.</p>'
  },
  {
    id: 'H5A-PERF-004',
    title: 'Local resilient fonts',
    requirement: 'Required fonts are local and include a system fallback.',
    passed: '<style>body{font-family:system-ui,sans-serif}</style>',
    failed: '<link rel="stylesheet" href="https://fonts.example/font.css">',
    inapplicable: '<p>No custom font declaration.</p>'
  },
  {
    id: 'H5A-PERF-005',
    title: 'No audible autoplay',
    requirement: 'Audio and video do not autoplay with sound.',
    passed: '<video autoplay muted src="demo.mp4"></video>',
    failed: '<audio autoplay src="intro.mp3"></audio>',
    inapplicable: '<p>No media.</p>'
  },
  {
    id: 'H5A-PERF-006',
    title: 'Non-blocking scripts',
    requirement: 'Non-critical scripts use module or defer.',
    passed: '<script type="module" src="app.js"></script>',
    failed: '<script src="app.js"></script>',
    inapplicable: '<p>No scripts.</p>'
  },

  {
    id: 'H5A-THEME-001',
    title: 'Semantic theme tokens',
    requirement: 'CFF component CSS uses semantic theme tokens instead of raw colors.',
    passed: '<style>.card{color:var(--cf-text);background:var(--cf-surface)}</style>',
    failed: '<style>.card{color:#17202a;background:#fff}</style>',
    inapplicable: '<p>Non-CFF content without authored component CSS.</p>'
  },
  {
    id: 'H5A-THEME-002',
    title: 'Complete light and dark roles',
    requirement: 'Light and dark themes declare all required semantic color roles.',
    passed: '<link rel="stylesheet" href="theme.css">',
    failed: '<style>:root{--cf-bg:#fff}</style>',
    inapplicable: '<p>Non-CFF content.</p>'
  },
  {
    id: 'H5A-THEME-003',
    title: 'Brand role responsibilities',
    requirement: 'Primary, secondary, and tertiary colors remain in their platform roles.',
    passed: '<style>.policy{color:var(--cf-tertiary)}</style><aside class="policy">Policy</aside>',
    failed:
      '<style>.fail-status{color:var(--cf-primary)}</style><strong class="fail-status">Fail</strong>',
    inapplicable: '<p>No brand-role styling.</p>'
  },
  {
    id: 'H5A-THEME-004',
    title: 'One primary action',
    requirement: 'One marked task region has no more than one filled primary action.',
    passed:
      '<section data-task-region><button data-action="primary">Analyze</button><button>Clear</button></section>',
    failed:
      '<section data-task-region><button data-action="primary">Analyze</button><button data-action="primary">Save</button></section>',
    inapplicable: '<p>No task region.</p>'
  },
  {
    id: 'H5A-THEME-005',
    title: 'Status colors reserved',
    requirement: 'Pass, check, and fail tokens are not used for brand decoration.',
    passed: '<style>.pass{color:var(--cf-pass)}</style><strong class="pass">Pass</strong>',
    failed: '<style>header{border-color:var(--cf-pass)}</style><header>Brand</header>',
    inapplicable: '<p>No status-token use.</p>'
  },
  {
    id: 'H5A-THEME-006',
    title: 'Decorative brand gradient',
    requirement: 'The brand gradient never carries text, focus, control, or status meaning.',
    passed:
      '<style>.cff-mark{background:var(--cf-brand-gradient)}</style><span class="cff-mark" aria-hidden="true"></span>',
    failed: '<style>button{background:var(--cf-brand-gradient)}</style><button>Analyze</button>',
    inapplicable: '<p>No brand gradient.</p>'
  }
] as const;

const cantTellRules = new Set([
  'H5A-DOC-005',
  'H5A-SEM-001',
  'H5A-SEM-002',
  'H5A-A11Y-004',
  'H5A-A11Y-005',
  'H5A-CSS-001',
  'H5A-CSS-002',
  'H5A-CSS-003',
  'H5A-CSS-004',
  'H5A-CSS-005',
  'H5A-CSS-007',
  'H5A-CSS-008',
  'H5A-CSS-010',
  'H5A-SAFE-001',
  'H5A-SAFE-006',
  'H5A-PERF-003',
  'H5A-PERF-004',
  'H5A-THEME-003',
  'H5A-THEME-006'
]);

const advisoryRules = new Set([
  'H5A-DOC-006',
  'H5A-SEM-003',
  'H5A-SEM-007',
  'H5A-A11Y-009',
  'H5A-CSS-009',
  'H5A-CSS-010',
  'H5A-SAFE-006',
  'H5A-CFF-006',
  'H5A-PERF-001',
  'H5A-PERF-002',
  'H5A-PERF-003',
  'H5A-PERF-006',
  'H5A-THEME-003',
  'H5A-THEME-004'
]);

const policyOnlyRules = new Set([
  'H5A-DOC-007',
  'H5A-A11Y-007',
  'H5A-CSS-006',
  'H5A-CSS-007',
  'H5A-CSS-009',
  'H5A-CSS-010',
  'H5A-SAFE-001',
  'H5A-SAFE-004',
  'H5A-SAFE-005',
  'H5A-SAFE-006',
  'H5A-PERF-001',
  'H5A-PERF-003',
  'H5A-PERF-004',
  ...seeds
    .filter((seed) => seed.id.startsWith('H5A-CFF-') || seed.id.startsWith('H5A-THEME-'))
    .map((seed) => seed.id)
]);

const familyOf = (id: string): string => id.split('-')[1] ?? 'UNKNOWN';

const exactReferences: Readonly<Record<string, readonly [string, string]>> = {
  'H5A-DOC-001': ['WHATWG HTML Living Standard', 'The DOCTYPE'],
  'H5A-DOC-002': ['WCAG 2.2', '3.1.1 Language of Page'],
  'H5A-DOC-003': ['WCAG 2.2', '2.4.2 Page Titled'],
  'H5A-DOC-004': ['WHATWG HTML Living Standard', 'The id attribute'],
  'H5A-DOC-005': ['WHATWG HTML Living Standard', 'Elements, attributes, and content models'],
  'H5A-DOC-006': ['WHATWG HTML Living Standard', 'Obsolete features'],
  'H5A-DOC-007': ['CFF web design contract', 'HTML5Assay 1.0 §3.1 and §6.1'],
  'H5A-SEM-001': ['WCAG 2.2', '1.3.1 Info and Relationships'],
  'H5A-SEM-002': ['WCAG 2.2', '2.4.1 Bypass Blocks'],
  'H5A-SEM-003': ['WCAG 2.2', '1.3.1 Info and Relationships'],
  'H5A-SEM-004': ['ARIA in HTML', 'Rules of ARIA use 1 and 2'],
  'H5A-SEM-005': ['WHATWG HTML Living Standard', 'The a and button elements'],
  'H5A-SEM-006': ['WCAG 2.2', '1.3.1 Info and Relationships'],
  'H5A-SEM-007': ['WCAG 2.2', '1.3.1 Info and Relationships'],
  'H5A-A11Y-001': ['WCAG 2.2', '1.1.1 Non-text Content'],
  'H5A-A11Y-002': ['WCAG 2.2', '4.1.2 Name, Role, Value'],
  'H5A-A11Y-003': ['WCAG 2.2', '4.1.2 Name, Role, Value'],
  'H5A-A11Y-004': ['WAI-ARIA 1.2', 'Roles, states, properties, and required owned elements'],
  'H5A-A11Y-005': ['ARIA in HTML', 'Rules of ARIA use 1 and 2'],
  'H5A-A11Y-006': ['WCAG 2.2', '2.4.3 Focus Order'],
  'H5A-A11Y-007': ['CFF web design contract', 'HTML5Assay 1.0 §9.3'],
  'H5A-A11Y-008': ['WCAG 2.2', '1.2.2 Captions (Prerecorded)'],
  'H5A-A11Y-009': ['WCAG 2.2', '4.1.3 Status Messages'],
  'H5A-CSS-001': ['WCAG 2.2', '2.4.7 Focus Visible and 2.4.11 Focus Not Obscured (Minimum)'],
  'H5A-CSS-002': ['WCAG 2.2', '1.4.1 Use of Color'],
  'H5A-CSS-003': ['WCAG 2.2', '1.4.3 Contrast (Minimum)'],
  'H5A-CSS-004': ['WCAG 2.2', '1.4.11 Non-text Contrast'],
  'H5A-CSS-005': ['WCAG 2.2', '2.5.8 Target Size (Minimum)'],
  'H5A-CSS-006': ['CFF web design contract', 'HTML5Assay 1.0 §10.12'],
  'H5A-CSS-007': ['CSS Color Adjustment Module Level 1', 'Forced color palettes'],
  'H5A-CSS-008': ['WCAG 2.2', '1.4.10 Reflow'],
  'H5A-CSS-009': ['CFF web design contract', 'HTML5Assay 1.0 §10.11'],
  'H5A-CSS-010': ['CFF web design contract', 'HTML5Assay 1.0 §10.11'],
  'H5A-SAFE-001': ['CFF web design contract', 'HTML5Assay 1.0 §3.1 and §9.5'],
  'H5A-SAFE-002': ['WHATWG HTML Living Standard', 'Event handler content attributes'],
  'H5A-SAFE-003': ['WHATWG HTML Living Standard', 'Links created by a and area elements'],
  'H5A-SAFE-004': ['CFF web design contract', 'HTML5Assay 1.0 §9.5'],
  'H5A-SAFE-005': ['CFF web design contract', 'HTML5Assay 1.0 §9.5'],
  'H5A-SAFE-006': ['CFF web design contract', 'HTML5Assay 1.0 §9.5'],
  'H5A-CFF-001': ['CFF web design contract', 'HTML5Assay 1.0 §11'],
  'H5A-CFF-002': ['CFF web design contract', 'HTML5Assay 1.0 §11'],
  'H5A-CFF-003': ['CFF web design contract', 'HTML5Assay 1.0 §11.3'],
  'H5A-CFF-004': ['CFF web design contract', 'HTML5Assay 1.0 §11.2'],
  'H5A-CFF-005': ['CFF web design contract', 'HTML5Assay 1.0 §11.2'],
  'H5A-CFF-006': ['CFF web design contract', 'HTML5Assay 1.0 §9.6 and §11.1'],
  'H5A-CFF-007': ['CFF web design contract', 'HTML5Assay 1.0 §10.5 and §11.2'],
  'H5A-PERF-001': ['CFF web performance policy', 'HTML5Assay 1.0 §9.7'],
  'H5A-PERF-002': ['WHATWG HTML Living Standard', 'The img element width and height attributes'],
  'H5A-PERF-003': ['CFF web performance policy', 'HTML5Assay 1.0 §9.7'],
  'H5A-PERF-004': ['CFF web performance policy', 'HTML5Assay 1.0 §9.7 and §10.15'],
  'H5A-PERF-005': ['WCAG 2.2', '1.4.2 Audio Control'],
  'H5A-PERF-006': ['WHATWG HTML Living Standard', 'The script element processing model'],
  'H5A-THEME-001': ['CFF Evidence theme contract', 'cff-evidence/1.0.0 semantic tokens'],
  'H5A-THEME-002': ['CFF Evidence theme contract', 'cff-evidence/1.0.0 light and dark roles'],
  'H5A-THEME-003': ['CFF Evidence theme contract', 'cff-evidence/1.0.0 brand roles'],
  'H5A-THEME-004': ['CFF Evidence theme contract', 'cff-evidence/1.0.0 action hierarchy'],
  'H5A-THEME-005': ['CFF Evidence theme contract', 'cff-evidence/1.0.0 status palette'],
  'H5A-THEME-006': ['CFF Evidence theme contract', 'cff-evidence/1.0.0 brand gradient']
};

const standardsFor = (seed: RuleSeed): readonly StandardsMapping[] => {
  const exact = exactReferences[seed.id];
  if (exact === undefined) throw new Error(`Missing exact standards mapping for ${seed.id}`);
  return [
    {
      authority: exact[0],
      reference: exact[1],
      automationLimit: `This rule tests only this static expectation: ${seed.requirement} It does not prove complete conformance, runtime behavior, rendering, or content quality.`
    }
  ];
};

const examplesFor = (seed: RuleSeed): readonly RuleExample[] => {
  const configuredPageKind =
    seed.id === 'H5A-CFF-003'
      ? 'playground'
      : seed.id === 'H5A-CFF-004'
        ? 'results'
        : seed.id.startsWith('H5A-CFF-') || seed.id.startsWith('H5A-THEME-')
          ? 'overview'
          : undefined;
  const contextFor = (outcome: RuleExample['outcome']): RuleExample['context'] | undefined => {
    const pageKind = outcome === 'inapplicable' ? undefined : configuredPageKind;
    const fragment =
      outcome === 'inapplicable' &&
      [
        'H5A-DOC-001',
        'H5A-DOC-002',
        'H5A-DOC-003',
        'H5A-DOC-005',
        'H5A-DOC-006',
        'H5A-SEM-001',
        'H5A-SEM-002',
        'H5A-SAFE-006',
        'H5A-PERF-001'
      ].includes(seed.id)
        ? { contextElement: 'div' }
        : undefined;
    const assets: Record<string, string> = {};
    if (seed.id === 'H5A-DOC-007' && outcome === 'passed') assets['styles/site.css'] = 'body{}';
    if (seed.id === 'H5A-A11Y-008' && outcome === 'passed') assets['captions.vtt'] = 'WEBVTT\n';
    if (seed.id === 'H5A-SAFE-001' && outcome === 'passed') assets['assets/app.js'] = '';
    if (seed.id === 'H5A-PERF-001' && outcome === 'passed') assets['small.css'] = '';
    if (seed.id === 'H5A-THEME-002' && outcome === 'passed')
      assets['theme.css'] = themeContractExample;
    const assetSizes: Record<string, number> = {};
    if (seed.id === 'H5A-PERF-001' && outcome === 'failed') assetSizes['oversize.js'] = 800_000;
    if (
      pageKind === undefined &&
      fragment === undefined &&
      Object.keys(assets).length === 0 &&
      Object.keys(assetSizes).length === 0
    )
      return undefined;
    return {
      ...(pageKind === undefined ? {} : { pageKind }),
      ...(fragment === undefined ? {} : { fragment }),
      ...(Object.keys(assets).length === 0 ? {} : { assets }),
      ...(Object.keys(assetSizes).length === 0 ? {} : { assetSizes })
    };
  };
  const makeExample = (
    outcome: RuleExample['outcome'],
    html: string,
    note: string
  ): RuleExample => {
    const context = contextFor(outcome);
    return context === undefined ? { outcome, html, note } : { outcome, html, note, context };
  };
  const examples: RuleExample[] = [
    makeExample('passed', seed.passed, `Meets ${seed.id}.`),
    makeExample('failed', seed.failed, `Violates ${seed.id}.`),
    makeExample('inapplicable', seed.inapplicable, `${seed.id} does not apply.`)
  ];
  if (cantTellRules.has(seed.id)) {
    const cantTellHtml: Readonly<Record<string, string>> = {
      'H5A-DOC-005':
        '<!doctype html><html lang="en"><title>Page</title><body><table><tr><td>Conformance needs a broader content-model proof.</td></tr></table></body></html>',
      'H5A-SEM-001':
        '<style>@media print{.aux{display:none}}</style><main>Primary</main><main class="aux">Unresolved alternative</main>',
      'H5A-SEM-002':
        '<style>@media print{main{display:none}}</style><a href="#main">Jump to content</a><main id="main">Primary</main>',
      'H5A-A11Y-004': '<article aria-expanded="false">State</article>',
      'H5A-A11Y-005': '<section role="button">Unsupported host-role proof</section>',
      'H5A-CSS-001':
        '<style>:focus{outline:none;border:2px solid var(--runtime-focus)}</style><button>Focus</button>',
      'H5A-CSS-002': '<span class="pass-status">Ready</span>',
      'H5A-CSS-003': '<style>p{color:var(--runtime-value);background:#fff}</style><p>Text</p>',
      'H5A-CSS-004':
        '<style>button{border-color:var(--runtime-value);background:#fff}</style><button>Go</button>',
      'H5A-CSS-005': '<nav><a href="a.html">One</a><a href="b.html">Two</a></nav>',
      'H5A-CSS-007':
        '<style>button{color:#000;background:#fff;border:1px solid #000}</style><button>Go</button>',
      'H5A-CSS-008': '<style>main{width:var(--runtime-width)}</style><main>Text</main>',
      'H5A-CSS-010': '<style>@media(min-width:30rem){.item{display:grid}}</style>',
      'H5A-SAFE-001': '<iframe srcdoc="&lt;p&gt;Nested local markup&lt;/p&gt;"></iframe>',
      'H5A-SAFE-006': '<!doctype html><html lang="en"><title>Page</title></html>',
      'H5A-PERF-003': '<img src="hero.png" alt="Hero">',
      'H5A-PERF-004': '<style>body{font-family:Inter,system-ui,sans-serif}</style>',
      'H5A-THEME-003': '<style>.unknown{color:var(--cf-primary)}</style>',
      'H5A-THEME-006': '<style>.banner{background:var(--cf-brand-gradient)}</style>'
    };
    examples.push(
      makeExample(
        'cantTell',
        cantTellHtml[seed.id] ?? '<div>Runtime-dependent evidence</div>',
        `The source cannot resolve all evidence required by ${seed.id}.`
      )
    );
  }
  return examples;
};

export const ruleCatalog: readonly RuleDefinition[] = seeds.map((seed) => {
  const family = familyOf(seed.id);
  const authority: Authority = policyOnlyRules.has(seed.id) ? 'cff-policy' : 'standard';
  const defaultLevel: FindingLevel = advisoryRules.has(seed.id) ? 'advisory' : 'blocking';
  return {
    id: seed.id,
    version: '1.0.0',
    title: seed.title,
    family,
    authority,
    defaultLevel,
    applicability: `Applies when source evidence relevant to ${seed.title.toLowerCase()} is present.`,
    expectations: [seed.requirement],
    assumptions: [
      'Only supplied bytes and local files inside the declared root are evidence.',
      'No script, browser, network request, or computed layout is evaluated.'
    ],
    standards: standardsFor(seed),
    examples: examplesFor(seed)
  };
});

export const rulesetIdentity = {
  id: 'html5assay-core' as const,
  version: '1.0.0' as const,
  digest: canonicalDigest({
    rules: ruleCatalog,
    standardsSnapshotDigest: '983a2c85c1ac96343d53beb5134064ec89501724fa650bb0acd9ebdae0b2234a'
  })
};

export const standardsIdentity = {
  id: 'html5assay-standards' as const,
  version: '1.0.0' as const,
  reviewDate: '2026-08-19' as const,
  digest: {
    algorithm: 'sha-256' as const,
    value: '983a2c85c1ac96343d53beb5134064ec89501724fa650bb0acd9ebdae0b2234a'
  },
  authoritySetDigest: {
    algorithm: 'sha-256' as const,
    value: 'a451a8cd888142bc32075b40bb27f2057f0143f1ff51dc5a3dad7165c4c92bff'
  }
};

export const findRule = (id: string): RuleDefinition | undefined =>
  ruleCatalog.find((rule) => rule.id === id.toUpperCase());

export const ruleIds: readonly string[] = ruleCatalog.map((rule) => rule.id);
