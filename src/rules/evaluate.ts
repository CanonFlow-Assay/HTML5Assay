import type {
  Finding,
  FindingLevel,
  PageManifest,
  PolicyPack,
  RuleEvaluation,
  RuleOutcome,
  SourceRange,
  SuppressionRecord
} from '../api/model.js';
import type { DocumentGraph, PageRecord, ReferenceEvidence } from '../graph/model.js';
import type { CssDeclaration, HtmlElement } from '../parse/types.js';
import { digest } from '../result/canonical.js';
import { ruleCatalog } from './catalog.js';

interface CheckResult {
  readonly outcome: RuleOutcome;
  readonly evidence?: readonly Evidence[];
}

interface Evidence {
  readonly path?: string;
  readonly range: SourceRange;
  readonly message: string;
  readonly observed: string;
  readonly certainty?: Finding['certainty'];
}

export interface EvaluationBundle {
  readonly evaluations: readonly RuleEvaluation[];
  readonly findings: readonly Finding[];
}

const zeroRange: SourceRange = {
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 0, line: 1, column: 1 }
};
const passed = (): CheckResult => ({ outcome: 'passed' });
const inapplicable = (): CheckResult => ({ outcome: 'inapplicable' });
const cantTell = (
  message: string,
  observed: string,
  range = zeroRange,
  path?: string
): CheckResult => ({
  outcome: 'cantTell',
  evidence: [
    { range, message, observed, certainty: 'contextual', ...(path === undefined ? {} : { path }) }
  ]
});
const failed = (evidence: readonly Evidence[]): CheckResult => ({ outcome: 'failed', evidence });

const elements = (page: PageRecord, tag?: string): readonly HtmlElement[] =>
  tag === undefined
    ? page.html.elements
    : page.html.elements.filter((element) => element.tagName === tag);
const attribute = (element: HtmlElement, name: string): string | undefined =>
  element.attributes[name];
const attributeRange = (element: HtmlElement, name: string): SourceRange =>
  element.attributeLocations[name] ?? element.range;
const visible = (element: HtmlElement): boolean =>
  attribute(element, 'hidden') === undefined &&
  attribute(element, 'aria-hidden') !== 'true' &&
  !/display\s*:\s*none/iu.test(attribute(element, 'style') ?? '');
const accessibleTextOf = (element: HtmlElement, page: PageRecord): string => {
  if (!visible(element)) return '';
  const content = [element.directText];
  for (const child of elements(page).filter(
    (candidate) => candidate.parentIndex === element.index
  )) {
    if (child.tagName === 'img') content.push(attribute(child, 'alt') ?? '');
    else content.push(accessibleTextOf(child, page));
  }
  return content.join(' ').replace(/\s+/gu, ' ').trim();
};
const nameOf = (element: HtmlElement, page: PageRecord): string => {
  const aria = attribute(element, 'aria-label')?.trim();
  if (aria !== undefined && aria !== '') return aria;
  const labelledBy = attribute(element, 'aria-labelledby')?.trim();
  if (labelledBy !== undefined && labelledBy !== '') {
    return labelledBy
      .split(/\s+/u)
      .map((id) =>
        accessibleTextOf(
          elements(page).find((candidate) => attribute(candidate, 'id') === id) ?? element,
          page
        )
      )
      .join(' ')
      .trim();
  }
  if (element.tagName === 'input') {
    const type = (attribute(element, 'type') ?? 'text').toLowerCase();
    if (type === 'image') return attribute(element, 'alt')?.trim() ?? '';
    if (['button', 'reset', 'submit'].includes(type))
      return attribute(element, 'value')?.trim() ?? '';
  }
  const content = accessibleTextOf(element, page);
  if (content !== '') return content;
  return attribute(element, 'title')?.trim() ?? '';
};

const declarations = (page: PageRecord): readonly CssDeclaration[] =>
  page.css.flatMap((sheet) => sheet.rules.flatMap((rule) => rule.declarations));
const effectiveDeclarations = (page: PageRecord): readonly CssDeclaration[] => {
  const effective = new Map<string, CssDeclaration>();
  for (const declaration of declarations(page)) {
    const key = `${declaration.atRuleContext.join('\0')}\0${declaration.selector}\0${declaration.property}`;
    const previous = effective.get(key);
    if (previous === undefined || declaration.important || !previous.important)
      effective.set(key, declaration);
  }
  return [...effective.values()];
};
const reducedMotionCovers = (page: PageRecord, motion: CssDeclaration): boolean =>
  effectiveDeclarations(page).some(
    (declaration) =>
      declaration.selector === motion.selector &&
      declaration.atRuleContext.some((context) =>
        /prefers-reduced-motion\s*:\s*reduce/iu.test(context)
      ) &&
      (motion.property.startsWith('animation')
        ? declaration.property.startsWith('animation')
        : declaration.property.startsWith('transition')) &&
      /^(?:none|0(?:ms|s)?)$/iu.test(declaration.value.trim())
  );
const forcedColorCategory = (property: string): string =>
  property.startsWith('background')
    ? 'background'
    : property.startsWith('border')
      ? 'border'
      : property.startsWith('outline') || property === 'box-shadow'
        ? 'focus-boundary'
        : property;
const forcedColorsCovers = (page: PageRecord, authored: CssDeclaration): boolean =>
  effectiveDeclarations(page).some(
    (declaration) =>
      declaration.selector === authored.selector &&
      declaration.atRuleContext.some((context) => /forced-colors\s*:\s*active/iu.test(context)) &&
      (declaration.property === 'forced-color-adjust' ||
        forcedColorCategory(declaration.property) === forcedColorCategory(authored.property))
  );

type Rgb = readonly [number, number, number];
const colors: Readonly<Record<string, Rgb>> = { black: [0, 0, 0], white: [255, 255, 255] };
const parseColor = (value: string): Rgb | null => {
  const normalized = value.trim().toLowerCase();
  if (colors[normalized] !== undefined) return colors[normalized] ?? null;
  const short = /^#([0-9a-f]{3})$/iu.exec(normalized)?.[1];
  if (short !== undefined)
    return [0, 1, 2].map((index) =>
      Number.parseInt(`${short[index]}${short[index]}`, 16)
    ) as unknown as Rgb;
  const full = /^#([0-9a-f]{6})$/iu.exec(normalized)?.[1];
  if (full !== undefined)
    return [0, 2, 4].map((index) =>
      Number.parseInt(full.slice(index, index + 2), 16)
    ) as unknown as Rgb;
  const rgb = /^rgb\(\s*(\d+)\s+?(?:,|\s)\s*(\d+)\s+?(?:,|\s)\s*(\d+)\s*\)$/iu.exec(normalized);
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] as Rgb;
  return null;
};
const luminance = (color: Rgb): number =>
  color
    .map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, index) => sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0);
const contrast = (left: Rgb, right: Rgb): number => {
  const first = luminance(left);
  const second = luminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

const cssRulePairs = (
  page: PageRecord
): readonly { selector: string; properties: ReadonlyMap<string, CssDeclaration> }[] =>
  [
    ...effectiveDeclarations(page)
      .filter((declaration) => declaration.atRuleContext.length === 0)
      .reduce((groups, declaration) => {
        const properties = groups.get(declaration.selector) ?? new Map<string, CssDeclaration>();
        properties.set(declaration.property, declaration);
        groups.set(declaration.selector, properties);
        return groups;
      }, new Map<string, Map<string, CssDeclaration>>())
      .entries()
  ].map(([selector, properties]) => ({ selector, properties }));

const referencesFor = (graph: DocumentGraph, page: PageRecord): readonly ReferenceEvidence[] =>
  graph.references.filter((reference) => {
    const pageSources = new Set([
      page.path,
      ...page.css.map((sheet) => sheet.path.replace(/#style-\d+$/u, ''))
    ]);
    return pageSources.has(reference.sourcePath);
  });

// This is the frozen HTML surface for exact element/attribute-name checks. It
// intentionally excludes foreign-content descendants and custom elements: they
// are reported as unproved instead of being declared conforming.
const htmlElements = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'selectedcontent',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr'
]);

const htmlGlobalAttributes = new Set([
  'accesskey',
  'autocapitalize',
  'autocorrect',
  'autofocus',
  'class',
  'contenteditable',
  'dir',
  'draggable',
  'enterkeyhint',
  'exportparts',
  'hidden',
  'id',
  'inert',
  'inputmode',
  'is',
  'itemid',
  'itemprop',
  'itemref',
  'itemscope',
  'itemtype',
  'lang',
  'nonce',
  'part',
  'popover',
  'role',
  'slot',
  'spellcheck',
  'style',
  'tabindex',
  'title',
  'translate',
  'virtualkeyboardpolicy',
  'writingsuggestions',
  'xmlns'
]);

const htmlElementAttributes: Readonly<Record<string, readonly string[]>> = {
  a: ['download', 'href', 'hreflang', 'ping', 'referrerpolicy', 'rel', 'target', 'type'],
  area: [
    'alt',
    'coords',
    'download',
    'href',
    'hreflang',
    'ping',
    'referrerpolicy',
    'rel',
    'shape',
    'target'
  ],
  audio: [
    'autoplay',
    'controls',
    'controlslist',
    'crossorigin',
    'disableremoteplayback',
    'loop',
    'muted',
    'preload',
    'src'
  ],
  base: ['href', 'target'],
  blockquote: ['cite'],
  button: [
    'command',
    'commandfor',
    'disabled',
    'form',
    'formaction',
    'formenctype',
    'formmethod',
    'formnovalidate',
    'formtarget',
    'name',
    'popovertarget',
    'popovertargetaction',
    'type',
    'value'
  ],
  canvas: ['height', 'width'],
  col: ['span'],
  colgroup: ['span'],
  data: ['value'],
  del: ['cite', 'datetime'],
  details: ['name', 'open'],
  dialog: ['closedby', 'open'],
  embed: ['height', 'src', 'type', 'width'],
  fieldset: ['disabled', 'form', 'name'],
  form: [
    'accept-charset',
    'action',
    'autocomplete',
    'enctype',
    'method',
    'name',
    'novalidate',
    'rel',
    'target'
  ],
  html: ['lang'],
  iframe: [
    'allow',
    'allowfullscreen',
    'browsingtopics',
    'credentialless',
    'csp',
    'height',
    'loading',
    'name',
    'referrerpolicy',
    'sandbox',
    'src',
    'srcdoc',
    'width'
  ],
  img: [
    'alt',
    'attributionsrc',
    'crossorigin',
    'decoding',
    'elementtiming',
    'fetchpriority',
    'height',
    'ismap',
    'loading',
    'referrerpolicy',
    'sizes',
    'src',
    'srcset',
    'usemap',
    'width'
  ],
  input: [
    'accept',
    'alpha',
    'alt',
    'autocomplete',
    'capture',
    'checked',
    'colorspace',
    'dirname',
    'disabled',
    'form',
    'formaction',
    'formenctype',
    'formmethod',
    'formnovalidate',
    'formtarget',
    'height',
    'list',
    'max',
    'maxlength',
    'min',
    'minlength',
    'multiple',
    'name',
    'pattern',
    'placeholder',
    'popovertarget',
    'popovertargetaction',
    'readonly',
    'required',
    'size',
    'src',
    'step',
    'type',
    'value',
    'width'
  ],
  ins: ['cite', 'datetime'],
  label: ['for'],
  li: ['value'],
  link: [
    'as',
    'blocking',
    'color',
    'crossorigin',
    'disabled',
    'fetchpriority',
    'href',
    'hreflang',
    'imagesizes',
    'imagesrcset',
    'integrity',
    'media',
    'referrerpolicy',
    'rel',
    'sizes',
    'type'
  ],
  map: ['name'],
  menu: ['type'],
  meta: ['charset', 'content', 'http-equiv', 'media', 'name'],
  meter: ['high', 'low', 'max', 'min', 'optimum', 'value'],
  object: ['data', 'form', 'height', 'name', 'type', 'usemap', 'width'],
  ol: ['reversed', 'start', 'type'],
  optgroup: ['disabled', 'label'],
  option: ['disabled', 'label', 'selected', 'value'],
  output: ['for', 'form', 'name'],
  progress: ['max', 'value'],
  q: ['cite'],
  script: [
    'async',
    'attributionsrc',
    'blocking',
    'crossorigin',
    'defer',
    'fetchpriority',
    'integrity',
    'nomodule',
    'referrerpolicy',
    'src',
    'type'
  ],
  select: ['autocomplete', 'disabled', 'form', 'multiple', 'name', 'required', 'size'],
  slot: ['name'],
  source: ['height', 'media', 'sizes', 'src', 'srcset', 'type', 'width'],
  style: ['blocking', 'media', 'type'],
  td: ['colspan', 'headers', 'rowspan'],
  textarea: [
    'autocomplete',
    'cols',
    'dirname',
    'disabled',
    'form',
    'maxlength',
    'minlength',
    'name',
    'placeholder',
    'readonly',
    'required',
    'rows',
    'wrap'
  ],
  th: ['abbr', 'colspan', 'headers', 'rowspan', 'scope'],
  time: ['datetime'],
  track: ['default', 'kind', 'label', 'src', 'srclang'],
  video: [
    'autoplay',
    'controls',
    'controlslist',
    'crossorigin',
    'disableremoteplayback',
    'height',
    'loop',
    'muted',
    'playsinline',
    'poster',
    'preload',
    'src',
    'width'
  ]
};

const htmlAttributeKnownFor = (element: HtmlElement, name: string): boolean =>
  htmlGlobalAttributes.has(name) ||
  /^aria-[a-z][a-z0-9-]*$/u.test(name) ||
  /^data-[a-z][a-z0-9._:-]*$/u.test(name) ||
  /^on[a-z]+$/u.test(name) ||
  (htmlElementAttributes[element.tagName]?.includes(name) ?? false);

const htmlAttributeValueIssue = (
  element: HtmlElement,
  name: string,
  value: string
): string | null => {
  const token = value.toLowerCase();
  const enumerated: Readonly<Record<string, readonly string[]>> = {
    autocapitalize: ['', 'none', 'off', 'sentences', 'on', 'words', 'characters'],
    contenteditable: ['', 'true', 'false', 'plaintext-only'],
    dir: ['ltr', 'rtl', 'auto'],
    draggable: ['true', 'false'],
    enterkeyhint: ['enter', 'done', 'go', 'next', 'previous', 'search', 'send'],
    hidden: ['', 'hidden', 'until-found'],
    inputmode: ['none', 'text', 'tel', 'url', 'email', 'numeric', 'decimal', 'search'],
    popover: ['', 'auto', 'manual', 'hint'],
    spellcheck: ['', 'true', 'false'],
    translate: ['', 'yes', 'no'],
    virtualkeyboardpolicy: ['', 'auto', 'manual'],
    writingsuggestions: ['true', 'false']
  };
  const allowed = enumerated[name];
  if (allowed !== undefined && !allowed.includes(token)) return `${name} has an invalid keyword`;
  if (name === 'tabindex' && !/^[+-]?\d+$/u.test(value.trim()))
    return 'tabindex must be a valid integer';
  const booleanAttributes = new Set([
    'allowfullscreen',
    'async',
    'autofocus',
    'autoplay',
    'checked',
    'controls',
    'default',
    'defer',
    'disabled',
    'formnovalidate',
    'inert',
    'ismap',
    'itemscope',
    'loop',
    'multiple',
    'muted',
    'nomodule',
    'novalidate',
    'open',
    'playsinline',
    'readonly',
    'required',
    'reversed',
    'selected'
  ]);
  if (booleanAttributes.has(name) && value !== '' && token !== name)
    return `${name} must use boolean-attribute syntax`;
  if (element.tagName === 'meta' && name === 'charset' && token !== 'utf-8')
    return 'The document character encoding declaration must be utf-8';
  return null;
};

const htmlContentIssue = (element: HtmlElement, all: readonly HtmlElement[]): string | null => {
  const parent = element.parentIndex === null ? null : (all[element.parentIndex]?.tagName ?? null);
  const requiredParents: Readonly<Record<string, readonly string[]>> = {
    area: ['map'],
    caption: ['table'],
    col: ['colgroup'],
    colgroup: ['table'],
    dd: ['dl', 'div'],
    dt: ['dl', 'div'],
    figcaption: ['figure'],
    legend: ['fieldset'],
    li: ['ol', 'ul', 'menu'],
    optgroup: ['select'],
    option: ['select', 'optgroup', 'datalist'],
    source: ['audio', 'video', 'picture'],
    summary: ['details'],
    tbody: ['table'],
    td: ['tr'],
    tfoot: ['table'],
    th: ['tr'],
    thead: ['table'],
    tr: ['table', 'thead', 'tbody', 'tfoot'],
    track: ['audio', 'video']
  };
  const allowed = requiredParents[element.tagName];
  if (allowed !== undefined && (parent === null || !allowed.includes(parent)))
    return `<${element.tagName}> is not in a permitted parent`;
  if (
    element.tagName === 'meta' &&
    parent !== 'head' &&
    attribute(element, 'itemprop') === undefined
  )
    return '<meta> without itemprop must be in head';
  const allowedChildren: Readonly<Record<string, readonly string[]>> = {
    ol: ['li', 'script', 'template'],
    ul: ['li', 'script', 'template'],
    menu: ['li', 'script', 'template'],
    tr: ['td', 'th', 'script', 'template'],
    select: ['hr', 'option', 'optgroup', 'script', 'template', 'button', 'selectedcontent']
  };
  const parentAllowed = parent === null ? undefined : allowedChildren[parent];
  if (parentAllowed !== undefined && !parentAllowed.includes(element.tagName))
    return `<${element.tagName}> is not permitted as a child of <${parent}>`;
  const children = all.filter((candidate) => candidate.parentIndex === element.index);
  const phrasing = new Set([
    'a',
    'abbr',
    'audio',
    'b',
    'bdi',
    'bdo',
    'br',
    'button',
    'canvas',
    'cite',
    'code',
    'data',
    'del',
    'dfn',
    'em',
    'embed',
    'i',
    'iframe',
    'img',
    'input',
    'ins',
    'kbd',
    'label',
    'map',
    'mark',
    'meter',
    'noscript',
    'object',
    'output',
    'picture',
    'progress',
    'q',
    'ruby',
    's',
    'samp',
    'script',
    'select',
    'slot',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'svg',
    'template',
    'textarea',
    'time',
    'u',
    'var',
    'video',
    'wbr'
  ]);
  if (
    [
      'p',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'abbr',
      'b',
      'bdi',
      'bdo',
      'cite',
      'code',
      'dfn',
      'em',
      'i',
      'kbd',
      'mark',
      'q',
      's',
      'samp',
      'small',
      'span',
      'strong',
      'sub',
      'sup',
      'time',
      'u',
      'var'
    ].includes(element.tagName) &&
    children.some((child) => !phrasing.has(child.tagName))
  )
    return `<${element.tagName}> may contain only phrasing content`;
  if (
    element.tagName === 'html' &&
    children.some((child) => !['head', 'body'].includes(child.tagName))
  )
    return '<html> may contain only head and body';
  if (
    element.tagName === 'head' &&
    children.some(
      (child) =>
        !['base', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title'].includes(
          child.tagName
        )
    )
  )
    return '<head> contains a non-metadata child';
  if (
    element.tagName === 'a' &&
    all.some(
      (candidate) =>
        isDescendant(candidate, element, all) &&
        (['a', 'button', 'input', 'select', 'textarea'].includes(candidate.tagName) ||
          attribute(candidate, 'tabindex') !== undefined)
    )
  )
    return '<a> contains interactive content';
  if (
    ['header', 'footer'].includes(element.tagName) &&
    all.some(
      (candidate) =>
        isDescendant(candidate, element, all) && ['header', 'footer'].includes(candidate.tagName)
    )
  )
    return `<${element.tagName}> contains a prohibited header or footer descendant`;
  if (element.tagName === 'main') {
    let ancestor = element.parentIndex;
    while (ancestor !== null) {
      const tag = all[ancestor]?.tagName;
      if (tag !== undefined && ['article', 'aside', 'footer', 'header', 'nav'].includes(tag))
        return '<main> is nested in a prohibited sectioning or landmark element';
      ancestor = all[ancestor]?.parentIndex ?? null;
    }
  }
  return null;
};

const checkDocument = (ruleId: string, page: PageRecord, graph: DocumentGraph): CheckResult => {
  const all = elements(page);
  switch (ruleId) {
    case 'H5A-DOC-001':
      if (page.html.fragment) return inapplicable();
      return /^<!doctype html>/iu.test(page.html.source)
        ? passed()
        : failed([
            {
              range: zeroRange,
              message: 'The document does not start with the short HTML doctype.',
              observed: page.html.source.slice(0, 40)
            }
          ]);
    case 'H5A-DOC-002': {
      if (page.html.fragment) return inapplicable();
      const html = all.find((element) => element.tagName === 'html');
      const lang = html?.attributes.lang;
      return html !== undefined &&
        lang !== undefined &&
        /^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?|x(?:-[a-z0-9]{1,8})+)$/iu.test(
          lang
        )
        ? passed()
        : failed([
            {
              range: html?.range ?? zeroRange,
              message: 'The root html element needs a structurally valid lang value.',
              observed: lang ?? '(missing)'
            }
          ]);
    }
    case 'H5A-DOC-003': {
      if (page.html.fragment) return inapplicable();
      const titles = elements(page, 'title');
      const title = titles[0]?.text.trim() ?? '';
      const duplicates =
        title === ''
          ? []
          : graph.pages.filter(
              (candidate) =>
                !candidate.html.fragment &&
                elements(candidate, 'title').length === 1 &&
                elements(candidate, 'title')[0]?.text.trim() === title
            );
      return titles.length === 1 && title !== '' && duplicates.length === 1
        ? passed()
        : failed([
            {
              range: titles[0]?.range ?? zeroRange,
              message:
                duplicates.length > 1
                  ? 'Every analyzed full page needs a distinct title.'
                  : 'The document needs exactly one non-empty title.',
              observed:
                duplicates.length > 1
                  ? `${duplicates.length} pages use ${JSON.stringify(title)}`
                  : `${titles.length} title element(s)`
            }
          ]);
    }
    case 'H5A-DOC-004': {
      const seen = new Set<string>();
      const duplicates: Evidence[] = [];
      for (const element of all) {
        const id = attribute(element, 'id');
        if (id !== undefined && seen.has(id))
          duplicates.push({
            range: attributeRange(element, 'id'),
            message: `Identifier ${id} is duplicated.`,
            observed: id
          });
        if (id !== undefined) seen.add(id);
      }
      return duplicates.length === 0
        ? seen.size === 0
          ? inapplicable()
          : passed()
        : failed(duplicates);
    }
    case 'H5A-DOC-005': {
      if (page.html.fragment && all.length === 0) return inapplicable();
      const issues: Evidence[] = page.html.parseErrors.map((error) => ({
        range: error.range,
        message: `HTML parser reported ${error.code}.`,
        observed: error.code
      }));
      const unproved: Evidence[] = [];
      const inputTypes = new Set([
        'button',
        'checkbox',
        'color',
        'date',
        'datetime-local',
        'email',
        'file',
        'hidden',
        'image',
        'month',
        'number',
        'password',
        'radio',
        'range',
        'reset',
        'search',
        'submit',
        'tel',
        'text',
        'time',
        'url',
        'week'
      ]);
      const buttonTypes = new Set(['button', 'reset', 'submit']);
      const exactlyCoveredElements = new Set([
        'html',
        'head',
        'meta',
        'title',
        'body',
        'p',
        'a',
        'main',
        'h1'
      ]);
      for (const element of all) {
        if (!htmlElements.has(element.tagName)) {
          if (element.tagName.includes('-') || ['svg', 'math'].includes(element.tagName)) {
            unproved.push({
              range: element.range,
              message:
                'Custom or foreign-content conformance is outside the frozen exact HTML table.',
              observed: `<${element.tagName}>`
            });
          } else {
            issues.push({
              range: element.range,
              message: `The ${element.tagName} element is not defined by the pinned HTML snapshot.`,
              observed: `<${element.tagName}>`
            });
          }
          continue;
        }
        for (const name of Object.keys(element.attributes)) {
          if (!htmlAttributeKnownFor(element, name))
            issues.push({
              range: attributeRange(element, name),
              message: `The ${name} attribute is not permitted on ${element.tagName}.`,
              observed: `${element.tagName}[${name}]`
            });
          const valueIssue = htmlAttributeValueIssue(element, name, attribute(element, name) ?? '');
          if (valueIssue !== null)
            issues.push({
              range: attributeRange(element, name),
              message: valueIssue,
              observed: `${name}=${attribute(element, name) ?? ''}`
            });
        }
        const type = attribute(element, 'type')?.toLowerCase();
        if (element.tagName === 'input' && type !== undefined && !inputTypes.has(type))
          issues.push({
            range: attributeRange(element, 'type'),
            message: 'The input type keyword is invalid.',
            observed: type
          });
        if (element.tagName === 'button' && type !== undefined && !buttonTypes.has(type))
          issues.push({
            range: attributeRange(element, 'type'),
            message: 'The button type keyword is invalid.',
            observed: type
          });
        if (
          element.tagName === 'a' &&
          attribute(element, 'href') === undefined &&
          (attribute(element, 'target') !== undefined ||
            attribute(element, 'download') !== undefined)
        )
          issues.push({
            range: element.range,
            message: 'An a element without href cannot use link-only attributes.',
            observed: '<a> without href'
          });
        const contentIssue = htmlContentIssue(element, all);
        if (contentIssue !== null)
          issues.push({
            range: element.range,
            message: contentIssue,
            observed: `<${element.tagName}>`
          });
        if (!exactlyCoveredElements.has(element.tagName))
          unproved.push({
            range: element.range,
            message: 'The element content model is not fully decidable by this source-only table.',
            observed: `<${element.tagName}>`
          });
      }
      if (issues.length > 0) return failed(issues);
      return unproved.length > 0
        ? {
            outcome: 'cantTell',
            evidence: unproved
              .slice(0, 1)
              .map((item) => ({ ...item, certainty: 'contextual' as const }))
          }
        : passed();
    }
    case 'H5A-DOC-006': {
      const obsolete = new Set([
        'acronym',
        'applet',
        'basefont',
        'big',
        'center',
        'dir',
        'font',
        'frame',
        'frameset',
        'marquee',
        'nobr',
        'strike',
        'tt'
      ]);
      const found = all.filter((element) => obsolete.has(element.tagName));
      const obsoleteAttributes = new Set([
        'align',
        'alink',
        'axis',
        'background',
        'bgcolor',
        'border',
        'cellpadding',
        'cellspacing',
        'char',
        'charoff',
        'clear',
        'compact',
        'frame',
        'frameborder',
        'hspace',
        'language',
        'link',
        'marginheight',
        'marginwidth',
        'noshade',
        'nowrap',
        'rev',
        'rules',
        'scrolling',
        'text',
        'valign',
        'vlink',
        'vspace'
      ]);
      const attributes = all.flatMap((element) =>
        Object.keys(element.attributes)
          .filter((name) => obsoleteAttributes.has(name))
          .map((name) => ({ element, name }))
      );
      if (found.length === 0 && attributes.length === 0)
        return page.html.fragment ? inapplicable() : passed();
      return failed([
        ...found.map((element) => ({
          range: element.range,
          message: `Obsolete ${element.tagName} element is present.`,
          observed: `<${element.tagName}>`
        })),
        ...attributes.map(({ element, name }) => ({
          range: attributeRange(element, name),
          message: `Obsolete ${name} attribute is present.`,
          observed: `${element.tagName}[${name}]`
        }))
      ]);
    }
    case 'H5A-DOC-007': {
      const escaped = referencesFor(graph, page).filter((reference) => reference.kind === 'escape');
      return escaped.length === 0
        ? referencesFor(graph, page).length === 0
          ? inapplicable()
          : passed()
        : failed(
            escaped.map((reference) => ({
              range: reference.range,
              message: 'A local reference escapes the declared root.',
              observed: reference.value
            }))
          );
    }
    default:
      return inapplicable();
  }
};

const checkSemantics = (ruleId: string, page: PageRecord): CheckResult => {
  const all = elements(page);
  const visibilityOnPage = (element: HtmlElement): 'visible' | 'hidden' | 'unknown' => {
    if (!visible(element)) return 'hidden';
    const relevant = effectiveDeclarations(page).filter(
      (declaration) =>
        selectorMayMatch(declaration.selector, element, all) &&
        ['display', 'visibility'].includes(declaration.property)
    );
    const conditionalHide = relevant.some(
      (declaration) =>
        declaration.atRuleContext.length > 0 &&
        ((declaration.property === 'display' &&
          declaration.value.trim().toLowerCase() === 'none') ||
          (declaration.property === 'visibility' &&
            ['hidden', 'collapse'].includes(declaration.value.trim().toLowerCase())))
    );
    const unconditional = relevant.filter((declaration) => declaration.atRuleContext.length === 0);
    if (unconditional.length === 0) return conditionalHide ? 'unknown' : 'visible';
    const scopes = new Set(
      unconditional.map(
        (declaration) => `${declaration.path}\0${declaration.selector}\0${declaration.property}`
      )
    );
    if (
      scopes.size !== 1 &&
      unconditional.some((declaration) =>
        ['none', 'hidden', 'collapse'].includes(declaration.value.trim().toLowerCase())
      )
    )
      return 'unknown';
    const last = unconditional.at(-1);
    if (last?.property === 'display')
      return last.value.trim().toLowerCase() === 'none' ? 'hidden' : 'visible';
    return ['hidden', 'collapse'].includes(last?.value.trim().toLowerCase() ?? '')
      ? 'hidden'
      : 'visible';
  };
  switch (ruleId) {
    case 'H5A-SEM-001': {
      if (page.html.fragment) return inapplicable();
      const candidates = all.filter(
        (element) => element.tagName === 'main' || attribute(element, 'role') === 'main'
      );
      const mains = candidates.filter((element) => visibilityOnPage(element) === 'visible');
      const unknown = candidates.filter((element) => visibilityOnPage(element) === 'unknown');
      if (mains.length <= 1 && unknown.length > 0)
        return cantTell(
          'CSS cascade or conditional rules prevent an exact visible-main count.',
          `${mains.length} visible and ${unknown.length} unresolved main landmarks`,
          unknown[0]?.range ?? zeroRange
        );
      return mains.length === 1
        ? passed()
        : failed([
            {
              range: mains[0]?.range ?? zeroRange,
              message: 'The page needs exactly one visible primary main landmark.',
              observed: `${mains.length} visible main landmarks`
            }
          ]);
    }
    case 'H5A-SEM-002': {
      if (page.html.fragment) return inapplicable();
      const mainCandidates = all.filter((element) => element.tagName === 'main');
      if (mainCandidates.some((element) => visibilityOnPage(element) === 'unknown'))
        return cantTell(
          'CSS cascade or conditional rules prevent proving the primary skip target is visible.',
          'unresolved main visibility',
          mainCandidates[0]?.range ?? zeroRange
        );
      const mains = mainCandidates.filter((element) => visibilityOnPage(element) === 'visible');
      const targetIds = new Set(
        mains
          .map((main) => attribute(main, 'id'))
          .filter((value): value is string => value !== undefined)
      );
      const firstMainIndex = Math.min(...mains.map((main) => main.index));
      const skips = elements(page, 'a').filter(
        (link) => link.index < firstMainIndex && (attribute(link, 'href')?.startsWith('#') ?? false)
      );
      const targeted = skips.filter((link) =>
        targetIds.has((attribute(link, 'href') ?? '').slice(1))
      );
      const unresolved = targeted.find((link) => visibilityOnPage(link) === 'unknown');
      if (unresolved !== undefined)
        return cantTell(
          'CSS cascade or conditional rules prevent proving the bypass link is visible.',
          'unresolved skip-link visibility',
          unresolved.range
        );
      const valid = targeted.some((link) => visibilityOnPage(link) === 'visible');
      return valid
        ? passed()
        : failed([
            {
              range: skips[0]?.range ?? zeroRange,
              message: 'A visible skip link must target the primary main element.',
              observed: skips[0]?.attributes.href ?? '(missing)'
            }
          ]);
    }
    case 'H5A-SEM-003': {
      const headings = all.filter((element) => /^h[1-6]$/u.test(element.tagName));
      if (headings.length === 0) return inapplicable();
      const issues: Evidence[] = [];
      let previous = 0;
      for (const heading of headings) {
        const level = Number(heading.tagName.slice(1));
        if (previous > 0 && level > previous + 1)
          issues.push({
            range: heading.range,
            message: `Heading level jumps from h${previous} to h${level}.`,
            observed: heading.tagName,
            certainty: 'heuristic'
          });
        previous = level;
      }
      return issues.length === 0 ? passed() : failed(issues);
    }
    case 'H5A-SEM-004': {
      const custom = all.filter(
        (element) =>
          ['button', 'link', 'checkbox', 'radio', 'textbox'].includes(
            attribute(element, 'role') ?? ''
          ) && !['button', 'a', 'input', 'select', 'textarea'].includes(element.tagName)
      );
      if (custom.length > 0)
        return failed(
          custom.map((element) => ({
            range: attributeRange(element, 'role'),
            message: 'Use the native HTML element for this static interaction.',
            observed: `${element.tagName}[role=${attribute(element, 'role')}]`
          }))
        );
      return all.some((element) =>
        ['button', 'a', 'input', 'select', 'textarea'].includes(element.tagName)
      )
        ? passed()
        : inapplicable();
    }
    case 'H5A-SEM-005': {
      const interactive = all.filter(
        (element) => element.tagName === 'a' || element.tagName === 'button'
      );
      if (interactive.length === 0) return inapplicable();
      const bad = interactive.filter(
        (element) =>
          element.tagName === 'a' &&
          (!attribute(element, 'href') ||
            /^(?:#\s*$|javascript:)/iu.test(attribute(element, 'href') ?? '') ||
            attribute(element, 'role') === 'button')
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((element) => ({
              range: element.range,
              message: 'Links navigate; use a button for actions and a real href for navigation.',
              observed: attribute(element, 'href') ?? '(missing)'
            }))
          );
    }
    case 'H5A-SEM-006': {
      const tables = elements(page, 'table');
      if (tables.length === 0) return inapplicable();
      const bad = tables.filter(
        (table) =>
          !all.some((element) => element.tagName === 'th' && isDescendant(element, table, all)) ||
          !all.some(
            (element) => element.tagName === 'caption' && element.parentIndex === table.index
          )
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((table) => ({
              range: table.range,
              message: 'The data table needs header cells and a caption.',
              observed: '<table>'
            }))
          );
    }
    case 'H5A-SEM-007': {
      const landmarkTags = ['nav', 'aside', 'form'];
      const issues: Evidence[] = [];
      for (const tag of landmarkTags) {
        const landmarks = elements(page, tag);
        if (landmarks.length > 1) {
          const names = new Set<string>();
          for (const landmark of landmarks) {
            const label = attribute(landmark, 'aria-label')?.trim() ?? '';
            const labelledBy = (attribute(landmark, 'aria-labelledby') ?? '')
              .split(/\s+/u)
              .filter(Boolean);
            const name =
              label !== ''
                ? label
                : labelledBy
                    .map(
                      (id) =>
                        all.find((candidate) => attribute(candidate, 'id') === id)?.text.trim() ??
                        ''
                    )
                    .join(' ')
                    .trim();
            if (name === '' || names.has(name))
              issues.push({
                range: landmark.range,
                message: `Repeated ${tag} landmarks need unique names.`,
                observed: name || '(missing)'
              });
            names.add(name);
          }
        }
      }
      const repeated = landmarkTags.some((tag) => elements(page, tag).length > 1);
      return issues.length > 0 ? failed(issues) : repeated ? passed() : inapplicable();
    }
    default:
      return inapplicable();
  }
};

const isDescendant = (
  candidate: HtmlElement,
  ancestor: HtmlElement,
  all: readonly HtmlElement[]
): boolean => {
  let parent = candidate.parentIndex;
  while (parent !== null) {
    if (parent === ancestor.index) return true;
    parent = all[parent]?.parentIndex ?? null;
  }
  return false;
};

const controlHasName = (control: HtmlElement, page: PageRecord): boolean => {
  if (nameOf(control, page) !== '') return true;
  if ((attribute(control, 'title')?.trim() ?? '') !== '') return true;
  const id = attribute(control, 'id');
  if (
    id !== undefined &&
    elements(page, 'label').some(
      (label) => attribute(label, 'for') === id && label.text.trim() !== ''
    )
  )
    return true;
  return elements(page, 'label').some(
    (label) => isDescendant(control, label, page.html.elements) && label.text.trim() !== ''
  );
};

const ariaRoles = new Set([
  'alert',
  'alertdialog',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'dialog',
  'directory',
  'document',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem'
]);

const globalAria = new Set([
  'aria-atomic',
  'aria-braillelabel',
  'aria-brailleroledescription',
  'aria-busy',
  'aria-controls',
  'aria-current',
  'aria-describedby',
  'aria-description',
  'aria-details',
  'aria-disabled',
  'aria-dropeffect',
  'aria-errormessage',
  'aria-flowto',
  'aria-grabbed',
  'aria-haspopup',
  'aria-hidden',
  'aria-invalid',
  'aria-keyshortcuts',
  'aria-label',
  'aria-labelledby',
  'aria-live',
  'aria-owns',
  'aria-relevant',
  'aria-roledescription'
]);

const roleAria: Readonly<Record<string, readonly string[]>> = {
  button: ['aria-expanded', 'aria-pressed'],
  checkbox: ['aria-checked', 'aria-readonly', 'aria-required'],
  columnheader: ['aria-sort', 'aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan'],
  combobox: [
    'aria-activedescendant',
    'aria-autocomplete',
    'aria-expanded',
    'aria-multiline',
    'aria-readonly',
    'aria-required'
  ],
  grid: ['aria-colcount', 'aria-multiselectable', 'aria-readonly', 'aria-rowcount'],
  gridcell: [
    'aria-colindex',
    'aria-colspan',
    'aria-readonly',
    'aria-required',
    'aria-rowindex',
    'aria-rowspan',
    'aria-selected'
  ],
  heading: ['aria-level'],
  link: ['aria-expanded'],
  listbox: [
    'aria-activedescendant',
    'aria-multiselectable',
    'aria-orientation',
    'aria-readonly',
    'aria-required'
  ],
  menuitemcheckbox: ['aria-checked', 'aria-posinset', 'aria-setsize'],
  menuitemradio: ['aria-checked', 'aria-posinset', 'aria-setsize'],
  option: ['aria-checked', 'aria-posinset', 'aria-selected', 'aria-setsize'],
  progressbar: ['aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext'],
  radio: ['aria-checked', 'aria-posinset', 'aria-setsize'],
  radiogroup: ['aria-orientation', 'aria-readonly', 'aria-required'],
  row: ['aria-colindex', 'aria-level', 'aria-rowindex', 'aria-selected', 'aria-setsize'],
  rowheader: ['aria-sort', 'aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan'],
  scrollbar: [
    'aria-orientation',
    'aria-valuemax',
    'aria-valuemin',
    'aria-valuenow',
    'aria-valuetext'
  ],
  searchbox: [
    'aria-activedescendant',
    'aria-autocomplete',
    'aria-multiline',
    'aria-placeholder',
    'aria-readonly',
    'aria-required'
  ],
  separator: [
    'aria-orientation',
    'aria-valuemax',
    'aria-valuemin',
    'aria-valuenow',
    'aria-valuetext'
  ],
  slider: ['aria-orientation', 'aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext'],
  spinbutton: ['aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext'],
  switch: ['aria-checked', 'aria-readonly'],
  tab: ['aria-posinset', 'aria-selected', 'aria-setsize'],
  tablist: ['aria-level', 'aria-multiselectable', 'aria-orientation'],
  textbox: [
    'aria-activedescendant',
    'aria-autocomplete',
    'aria-multiline',
    'aria-placeholder',
    'aria-readonly',
    'aria-required'
  ],
  tree: ['aria-multiselectable', 'aria-orientation', 'aria-required'],
  treegrid: [
    'aria-colcount',
    'aria-multiselectable',
    'aria-readonly',
    'aria-required',
    'aria-rowcount'
  ],
  treeitem: [
    'aria-checked',
    'aria-expanded',
    'aria-level',
    'aria-posinset',
    'aria-selected',
    'aria-setsize'
  ]
};

const implicitAriaRole = (element: HtmlElement): string | null => {
  if (element.tagName === 'button') return 'button';
  if (element.tagName === 'a' && attribute(element, 'href') !== undefined) return 'link';
  if (element.tagName === 'th')
    return attribute(element, 'scope') === 'row' ? 'rowheader' : 'columnheader';
  if (element.tagName === 'textarea') return 'textbox';
  if (element.tagName === 'select')
    return attribute(element, 'multiple') !== undefined ||
      Number(attribute(element, 'size') ?? '0') > 1
      ? 'listbox'
      : 'combobox';
  if (element.tagName === 'input') {
    const type = (attribute(element, 'type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (type === 'search')
      return attribute(element, 'list') === undefined ? 'searchbox' : 'combobox';
    if (['email', 'tel', 'text', 'url'].includes(type))
      return attribute(element, 'list') === undefined ? 'textbox' : 'combobox';
  }
  return ['p', 'div', 'span'].includes(element.tagName) ? 'generic' : null;
};

const roleOf = (element: HtmlElement): string | null =>
  attribute(element, 'role') ?? implicitAriaRole(element);

const ownsRole = (
  owner: HtmlElement,
  expected: ReadonlySet<string>,
  all: readonly HtmlElement[]
): boolean => {
  if (
    all.some(
      (candidate) => isDescendant(candidate, owner, all) && expected.has(roleOf(candidate) ?? '')
    )
  )
    return true;
  const ownedIds = (attribute(owner, 'aria-owns') ?? '').split(/\s+/u).filter(Boolean);
  return ownedIds.some((id) => {
    const candidate = all.find((element) => attribute(element, 'id') === id);
    return candidate !== undefined && expected.has(roleOf(candidate) ?? '');
  });
};

const checkA11y = (ruleId: string, page: PageRecord, graph: DocumentGraph): CheckResult => {
  const all = elements(page);
  switch (ruleId) {
    case 'H5A-A11Y-001': {
      const images = all.filter(
        (element) =>
          element.tagName === 'img' ||
          (element.tagName === 'input' && attribute(element, 'type')?.toLowerCase() === 'image')
      );
      if (images.length === 0) return inapplicable();
      const bad = images.filter(
        (image) =>
          attribute(image, 'alt') === undefined ||
          (image.tagName === 'input' && attribute(image, 'alt')?.trim() === '')
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((image) => ({
              range: image.range,
              message: 'The image needs an explicit alt attribute.',
              observed: '<img> without alt'
            }))
          );
    }
    case 'H5A-A11Y-002': {
      const controls = all.filter(
        (element) =>
          ['input', 'select', 'textarea'].includes(element.tagName) &&
          !(element.tagName === 'input' && attribute(element, 'type') === 'hidden')
      );
      if (controls.length === 0) return inapplicable();
      const bad = controls.filter((control) => !controlHasName(control, page));
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((control) => ({
              range: control.range,
              message: 'The form control needs a programmatic accessible name.',
              observed: `<${control.tagName}>`
            }))
          );
    }
    case 'H5A-A11Y-003': {
      const controls = all.filter((element) => ['button', 'a'].includes(element.tagName));
      if (controls.length === 0) return inapplicable();
      const bad = controls.filter((control) => nameOf(control, page) === '');
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((control) => ({
              range: control.range,
              message: 'The button or link needs a non-empty accessible name.',
              observed: `<${control.tagName}>`
            }))
          );
    }
    case 'H5A-A11Y-004': {
      const aria = all.filter(
        (element) =>
          Object.keys(element.attributes).some((name) => name.startsWith('aria-')) ||
          attribute(element, 'role') !== undefined
      );
      if (aria.length === 0) return inapplicable();
      const booleanAria = new Set([
        'aria-atomic',
        'aria-busy',
        'aria-disabled',
        'aria-expanded',
        'aria-hidden',
        'aria-modal',
        'aria-multiline',
        'aria-multiselectable',
        'aria-readonly',
        'aria-required',
        'aria-selected'
      ]);
      const tristateAria = new Set(['aria-checked', 'aria-pressed']);
      const tokenAria: Readonly<Record<string, ReadonlySet<string>>> = {
        'aria-autocomplete': new Set(['none', 'inline', 'list', 'both']),
        'aria-current': new Set(['false', 'true', 'page', 'step', 'location', 'date', 'time']),
        'aria-haspopup': new Set(['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog']),
        'aria-invalid': new Set(['false', 'true', 'grammar', 'spelling']),
        'aria-live': new Set(['off', 'polite', 'assertive']),
        'aria-orientation': new Set(['horizontal', 'vertical', 'undefined']),
        'aria-sort': new Set(['ascending', 'descending', 'none', 'other'])
      };
      const knownAria = new Set([
        ...booleanAria,
        ...tristateAria,
        'aria-activedescendant',
        'aria-autocomplete',
        'aria-colcount',
        'aria-colindex',
        'aria-colspan',
        'aria-controls',
        'aria-current',
        'aria-describedby',
        'aria-description',
        'aria-details',
        'aria-dropeffect',
        'aria-errormessage',
        'aria-flowto',
        'aria-grabbed',
        'aria-haspopup',
        'aria-invalid',
        'aria-keyshortcuts',
        'aria-label',
        'aria-labelledby',
        'aria-level',
        'aria-live',
        'aria-orientation',
        'aria-owns',
        'aria-placeholder',
        'aria-posinset',
        'aria-relevant',
        'aria-roledescription',
        'aria-braillelabel',
        'aria-brailleroledescription',
        'aria-rowcount',
        'aria-rowindex',
        'aria-rowspan',
        'aria-setsize',
        'aria-sort',
        'aria-valuemax',
        'aria-valuemin',
        'aria-valuenow',
        'aria-valuetext'
      ]);
      const issues: Evidence[] = [];
      let uncertain = false;
      for (const element of aria) {
        const explicitRole = attribute(element, 'role');
        if (
          explicitRole !== undefined &&
          (explicitRole.includes(' ') || !ariaRoles.has(explicitRole))
        )
          issues.push({
            range: attributeRange(element, 'role'),
            message: `ARIA role ${explicitRole} is not supported by this pinned catalogue.`,
            observed: explicitRole
          });
        const role = roleOf(element);
        for (const [name, value] of Object.entries(element.attributes)) {
          if (name.startsWith('aria-') && !knownAria.has(name))
            issues.push({
              range: attributeRange(element, name),
              message: `Unknown ARIA property ${name}.`,
              observed: name
            });
          if (name.startsWith('aria-') && knownAria.has(name) && !globalAria.has(name)) {
            if (role === null) uncertain = true;
            else if (!(roleAria[role]?.includes(name) ?? false))
              issues.push({
                range: attributeRange(element, name),
                message: `${name} is not supported by the ${role} role.`,
                observed: `<${element.tagName} ${name}>`
              });
          }
          if (booleanAria.has(name) && !['true', 'false', 'undefined'].includes(value))
            issues.push({
              range: attributeRange(element, name),
              message: `${name} has an invalid token.`,
              observed: value
            });
          if (tristateAria.has(name) && !['true', 'false', 'mixed', 'undefined'].includes(value))
            issues.push({
              range: attributeRange(element, name),
              message: `${name} has an invalid token.`,
              observed: value
            });
          if (tokenAria[name] !== undefined && !tokenAria[name].has(value))
            issues.push({
              range: attributeRange(element, name),
              message: `${name} has an invalid token.`,
              observed: `${name}=${value}`
            });
          if (
            [
              'aria-level',
              'aria-colcount',
              'aria-colindex',
              'aria-colspan',
              'aria-rowcount',
              'aria-rowindex',
              'aria-rowspan',
              'aria-posinset',
              'aria-setsize'
            ].includes(name) &&
            (!/^-?\d+$/u.test(value) ||
              ([
                'aria-level',
                'aria-colindex',
                'aria-colspan',
                'aria-rowindex',
                'aria-rowspan'
              ].includes(name) &&
                Number(value) < 1))
          )
            issues.push({
              range: attributeRange(element, name),
              message: `${name} needs a valid integer value.`,
              observed: value
            });
        }
        if (
          role === 'heading' &&
          attribute(element, 'aria-level') === undefined &&
          !/^h[1-6]$/u.test(element.tagName)
        )
          issues.push({
            range: element.range,
            message: 'An authored heading role needs aria-level.',
            observed: 'role=heading without aria-level'
          });
        if (
          role === 'combobox' &&
          (attribute(element, 'aria-expanded') === undefined ||
            attribute(element, 'aria-controls') === undefined)
        )
          issues.push({
            range: element.range,
            message: 'A combobox role needs aria-expanded and aria-controls.',
            observed: 'incomplete combobox state'
          });
        const requiredOwned: Readonly<Record<string, ReadonlySet<string>>> = {
          listbox: new Set(['option', 'group']),
          menu: new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group']),
          menubar: new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group']),
          radiogroup: new Set(['radio']),
          tablist: new Set(['tab']),
          tree: new Set(['treeitem', 'group'])
        };
        const expectedOwned = role === null ? undefined : requiredOwned[role];
        if (expectedOwned !== undefined && !ownsRole(element, expectedOwned, all))
          issues.push({
            range: element.range,
            message: `The ${role} role needs a required owned role.`,
            observed: `${role} without ${[...expectedOwned].join(' or ')}`
          });
        for (const referenceName of [
          'aria-activedescendant',
          'aria-controls',
          'aria-describedby',
          'aria-details',
          'aria-errormessage',
          'aria-flowto',
          'aria-labelledby',
          'aria-owns'
        ]) {
          const ids = attribute(element, referenceName);
          if (
            ids !== undefined &&
            ids
              .split(/\s+/u)
              .some(
                (id) => id !== '' && !all.some((candidate) => attribute(candidate, 'id') === id)
              )
          )
            issues.push({
              range: attributeRange(element, referenceName),
              message: `${referenceName} references an identifier that is not present.`,
              observed: ids
            });
        }
      }
      return issues.length > 0
        ? failed(issues)
        : uncertain
          ? cantTell(
              'The host role cannot be inferred exactly for one or more ARIA properties.',
              'manual host/property validation required'
            )
          : passed();
    }
    case 'H5A-A11Y-005': {
      const conflicts: Evidence[] = [];
      const allowed: Readonly<Record<string, readonly string[]>> = {
        button: [
          'button',
          'checkbox',
          'combobox',
          'link',
          'menuitem',
          'menuitemcheckbox',
          'menuitemradio',
          'option',
          'radio',
          'switch',
          'tab'
        ],
        a: [
          'link',
          'button',
          'checkbox',
          'menuitem',
          'menuitemcheckbox',
          'menuitemradio',
          'option',
          'radio',
          'switch',
          'tab'
        ],
        main: ['main'],
        nav: ['navigation'],
        h1: ['none', 'presentation', 'tab'],
        h2: ['none', 'presentation', 'tab'],
        h3: ['none', 'presentation', 'tab'],
        h4: ['none', 'presentation', 'tab'],
        h5: ['none', 'presentation', 'tab'],
        h6: ['none', 'presentation', 'tab'],
        input: ['combobox', 'searchbox', 'spinbutton', 'textbox']
      };
      let applicable = false;
      let unsupported = false;
      for (const element of all) {
        const role = attribute(element, 'role');
        const inputType = (attribute(element, 'type') ?? 'text').toLowerCase();
        const inputRoles: Readonly<Record<string, readonly string[]>> = {
          button: ['button'],
          checkbox: ['checkbox', 'switch'],
          email: ['textbox', 'combobox'],
          image: ['button'],
          number: ['spinbutton'],
          radio: ['radio'],
          range: ['slider'],
          reset: ['button'],
          search: ['searchbox', 'combobox'],
          submit: ['button'],
          tel: ['textbox'],
          text: ['textbox', 'combobox'],
          url: ['textbox']
        };
        const roles =
          element.tagName === 'input' ? inputRoles[inputType] : allowed[element.tagName];
        if (role !== undefined) {
          applicable = true;
          if (roles === undefined) unsupported = true;
        }
        if (role !== undefined && roles !== undefined && !roles.includes(role))
          conflicts.push({
            range: attributeRange(element, 'role'),
            message: 'ARIA role conflicts with native element semantics.',
            observed: `<${element.tagName} role="${role}">`
          });
      }
      return conflicts.length > 0
        ? failed(conflicts)
        : unsupported
          ? cantTell(
              'The host-role combination is outside the pinned exact host table.',
              'manual ARIA-in-HTML host validation required'
            )
          : applicable
            ? passed()
            : inapplicable();
    }
    case 'H5A-A11Y-006': {
      const indexed = all.filter((element) => attribute(element, 'tabindex') !== undefined);
      if (indexed.length === 0) return inapplicable();
      const bad = indexed.filter((element) => Number(attribute(element, 'tabindex')) > 0);
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((element) => ({
              range: attributeRange(element, 'tabindex'),
              message: 'Positive tabindex changes the natural focus order.',
              observed: attribute(element, 'tabindex') ?? ''
            }))
          );
    }
    case 'H5A-A11Y-007': {
      const bad = all.filter(
        (element) =>
          attribute(element, 'autofocus') !== undefined ||
          attribute(element, 'accesskey') !== undefined
      );
      if (bad.length > 0)
        return failed(
          bad.map((element) => ({
            range: element.range,
            message: 'Remove autofocus and accesskey unless a reviewed exception exists.',
            observed:
              attribute(element, 'autofocus') !== undefined
                ? 'autofocus'
                : `accesskey=${attribute(element, 'accesskey') ?? ''}`
          }))
        );
      return all.some((element) =>
        ['input', 'button', 'select', 'textarea'].includes(element.tagName)
      )
        ? passed()
        : inapplicable();
    }
    case 'H5A-A11Y-008': {
      const media = all.filter((element) => ['audio', 'video'].includes(element.tagName));
      if (media.length === 0) return inapplicable();
      const pageRefs = referencesFor(graph, page);
      const bad = media.filter(
        (item) =>
          !all.some((candidate) => {
            if (
              candidate.tagName !== 'track' ||
              candidate.parentIndex !== item.index ||
              !['captions', 'descriptions'].includes(attribute(candidate, 'kind') ?? '')
            )
              return false;
            return pageRefs.some(
              (reference) =>
                reference.elementIndex === candidate.index &&
                reference.attribute === 'src' &&
                reference.kind === 'local'
            );
          })
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((item) => ({
              range: item.range,
              message: 'Timed media needs local caption or transcript evidence.',
              observed: `<${item.tagName}> without track evidence`
            }))
          );
    }
    case 'H5A-A11Y-009': {
      const marked = all.filter(
        (element) =>
          /(?:^|\s)(?:status|message)(?:\s|$)/iu.test(attribute(element, 'class') ?? '') ||
          attribute(element, 'data-status-message') !== undefined ||
          element.tagName === 'output'
      );
      if (marked.length === 0) return inapplicable();
      const bad = marked.filter(
        (element) =>
          attribute(element, 'role') !== 'status' &&
          attribute(element, 'aria-live') !== 'polite' &&
          element.tagName !== 'output'
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((element) => ({
              range: element.range,
              message: 'The status message needs role=status or aria-live=polite.',
              observed: `<${element.tagName}>`
            }))
          );
    }
    default:
      return inapplicable();
  }
};

const compoundSelectorMatches = (input: string, element: HtmlElement): boolean => {
  let compound = input;
  if (compound === '' || /:(?:is|not|has|where)\(/iu.test(compound)) return false;
  const synthetic = /:--h5a-element-(\d+)/u.exec(compound)?.[1];
  if (synthetic !== undefined && Number(synthetic) !== element.index) return false;
  compound = compound.replace(/::?[a-z-][a-z0-9-]*(?:\([^)]*\))?/giu, '');
  const tag = /^(\*|[a-z][a-z0-9-]*)/iu.exec(compound)?.[1];
  if (tag !== undefined && tag !== '*' && tag.toLowerCase() !== element.tagName) return false;
  const ids = [...compound.matchAll(/#([a-z_][a-z0-9_-]*)/giu)].map((match) => match[1]);
  if (ids.some((id) => id !== attribute(element, 'id'))) return false;
  const classes = new Set((attribute(element, 'class') ?? '').split(/\s+/u).filter(Boolean));
  if (
    [...compound.matchAll(/\.([a-z_][a-z0-9_-]*)/giu)].some((match) => !classes.has(match[1] ?? ''))
  )
    return false;
  for (const match of compound.matchAll(
    /\[([a-z][a-z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/giu
  )) {
    const actual = attribute(element, match[1] ?? '');
    const expected = match[2] ?? match[3] ?? match[4];
    if (actual === undefined || (expected !== undefined && actual !== expected)) return false;
  }
  const remainder = compound
    .replace(/^(?:\*|[a-z][a-z0-9-]*)/iu, '')
    .replace(/#[a-z_][a-z0-9_-]*/giu, '')
    .replace(/\.[a-z_][a-z0-9_-]*/giu, '')
    .replace(/\[[^\]]+\]/gu, '');
  return remainder === '';
};

const selectorMayMatch = (
  selector: string,
  element: HtmlElement,
  all: readonly HtmlElement[] = []
): boolean =>
  selector.split(',').some((part) => {
    // Exact simple compounds, descendant chains, and child combinators are
    // supported. Sibling combinators remain unproved.
    const candidate = part.trim();
    if (/[+~]/u.test(candidate)) return false;
    const tokens = candidate
      .replace(/\s*>\s*/gu, ' > ')
      .split(/\s+/u)
      .filter(Boolean);
    const segments: string[] = [];
    const combinators: ('child' | 'descendant')[] = [];
    for (const token of tokens) {
      if (token === '>') {
        if (segments.length === 0 || combinators.length === segments.length) return false;
        combinators.push('child');
      } else {
        if (segments.length > 0 && combinators.length < segments.length)
          combinators.push('descendant');
        segments.push(token);
      }
    }
    if (combinators.length !== Math.max(0, segments.length - 1)) return false;
    if (segments.length === 0 || !compoundSelectorMatches(segments.at(-1) ?? '', element))
      return false;
    let parent = element.parentIndex;
    for (let index = segments.length - 2; index >= 0; index -= 1) {
      if (combinators[index] === 'child') {
        if (parent === null) return false;
        const ancestor = all[parent];
        if (ancestor === undefined || !compoundSelectorMatches(segments[index] ?? '', ancestor))
          return false;
        parent = ancestor.parentIndex;
        continue;
      }
      let found = false;
      while (parent !== null) {
        const ancestor = all[parent];
        parent = ancestor?.parentIndex ?? null;
        if (ancestor !== undefined && compoundSelectorMatches(segments[index] ?? '', ancestor)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  });

const pixelAtLeast = (declaration: CssDeclaration | undefined, minimum: number): boolean => {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(declaration?.value.trim() ?? '');
  return match !== null && Number(match[1]) >= minimum;
};

const checkCss = (ruleId: string, page: PageRecord): CheckResult => {
  const all = elements(page);
  const decls = effectiveDeclarations(page);
  const pairs = cssRulePairs(page);
  switch (ruleId) {
    case 'H5A-CSS-001': {
      const focusRules = pairs.filter((pair) => /:focus(?:-visible)?/iu.test(pair.selector));
      if (focusRules.length === 0) return inapplicable();
      const bad: (typeof focusRules)[number][] = [];
      const unresolved: (typeof focusRules)[number][] = [];
      for (const pair of focusRules) {
        const outline = pair.properties.get('outline');
        const removed = outline !== undefined && /^(?:0|none)(?:\s|$)/iu.test(outline.value);
        const replacements = ['box-shadow', 'border', 'border-color']
          .map((property) => pair.properties.get(property))
          .filter((item) => item !== undefined);
        if (!removed) continue;
        const definite = replacements.some((replacement) => {
          if (/(?:^|\s)(?:0|none|transparent)(?:\s|$)/iu.test(replacement.value)) return false;
          const width = /(\d+(?:\.\d+)?)px/u.exec(replacement.value);
          const tokens = replacement.value.trim().split(/\s+/u);
          return (
            width !== null &&
            Number(width[1]) >= 2 &&
            tokens.some((token) => parseColor(token) !== null)
          );
        });
        if (definite) continue;
        if (
          replacements.some((replacement) =>
            /(?:var\(|currentcolor|color-mix\()/iu.test(replacement.value)
          )
        )
          unresolved.push(pair);
        else bad.push(pair);
      }
      if (bad.length > 0)
        return failed(
          bad.map((pair) => {
            const outline = pair.properties.get('outline');
            return {
              ...(outline === undefined ? {} : { path: outline.path }),
              range: outline?.range ?? zeroRange,
              message: 'Focus outline is removed without a statically visible replacement.',
              observed: `${pair.selector}{outline:${outline?.value ?? ''}}`
            };
          })
        );
      if (unresolved.length > 0) {
        const replacement =
          unresolved[0]?.properties.get('border') ?? unresolved[0]?.properties.get('box-shadow');
        return cantTell(
          'Focus replacement color or thickness cannot be resolved from source.',
          replacement?.value ?? 'unresolved replacement',
          replacement?.range ?? zeroRange,
          replacement?.path
        );
      }
      return passed();
    }
    case 'H5A-CSS-002': {
      const statuses = elements(page).filter(
        (element) =>
          attribute(element, 'data-status') !== undefined ||
          /(?:pass|fail|error|warning|status)/iu.test(attribute(element, 'class') ?? '')
      );
      if (statuses.length === 0) return inapplicable();
      const empty = statuses.filter((element) => element.text.trim() === '');
      if (empty.length > 0)
        return failed(
          empty.map((element) => ({
            range: element.range,
            message: 'A status marker has no visible text or icon glyph beyond its color styling.',
            observed: element.attributes.class ?? '<status>'
          }))
        );
      const uncertain = statuses.filter(
        (element) => !/(?:pass|fail|error|warning|inconclusive|toolFailure)/iu.test(element.text)
      );
      return uncertain.length === 0
        ? passed()
        : cantTell(
            'Static source cannot prove that status is understandable without color.',
            `${uncertain.length} status marker(s) lack explicit status terms`,
            uncertain[0]?.range ?? zeroRange
          );
    }
    case 'H5A-CSS-003': {
      const relevant = pairs.filter(
        (pair) =>
          pair.properties.has('color') &&
          (pair.properties.has('background') || pair.properties.has('background-color'))
      );
      if (relevant.length === 0) {
        const split = decls.find((declaration) =>
          ['color', 'background', 'background-color'].includes(declaration.property)
        );
        return split === undefined
          ? inapplicable()
          : cantTell(
              'Foreground and adjacent background declarations are split across selectors, so the cascade cannot be resolved exactly.',
              `${split.selector}{${split.property}:${split.value}}`,
              split.range,
              split.path
            );
      }
      const issues: Evidence[] = [];
      let unresolved = 0;
      for (const pair of relevant) {
        const foregroundDecl = pair.properties.get('color');
        const backgroundDecl =
          pair.properties.get('background-color') ?? pair.properties.get('background');
        const foreground = parseColor(foregroundDecl?.value ?? '');
        const background = parseColor(backgroundDecl?.value ?? '');
        if (foreground === null || background === null) unresolved += 1;
        else if (contrast(foreground, background) < 4.5)
          issues.push({
            ...(foregroundDecl === undefined ? {} : { path: foregroundDecl.path }),
            range: foregroundDecl?.range ?? zeroRange,
            message: 'Resolved text contrast is below 4.5:1.',
            observed: `${foregroundDecl?.value ?? ''} on ${backgroundDecl?.value ?? ''}`
          });
      }
      if (issues.length > 0) return failed(issues);
      return unresolved > 0
        ? cantTell(
            'One or more text color pairs cannot be resolved from source.',
            `${unresolved} unresolved pair(s)`,
            relevant[0]?.properties.get('color')?.range ?? zeroRange,
            relevant[0]?.properties.get('color')?.path
          )
        : passed();
    }
    case 'H5A-CSS-004': {
      const relevant = pairs.filter(
        (pair) =>
          /button|input|select|textarea|:focus/iu.test(pair.selector) &&
          (pair.properties.has('border-color') ||
            pair.properties.has('outline-color') ||
            pair.properties.has('border')) &&
          (pair.properties.has('background') || pair.properties.has('background-color'))
      );
      if (relevant.length === 0) {
        const split = decls.find(
          (declaration) =>
            /button|input|select|textarea|:focus/iu.test(declaration.selector) &&
            ['border', 'border-color', 'outline-color'].includes(declaration.property)
        );
        return split === undefined
          ? inapplicable()
          : cantTell(
              'Control boundary and adjacent background declarations cannot be paired exactly from source.',
              `${split.selector}{${split.property}:${split.value}}`,
              split.range,
              split.path
            );
      }
      const issues: Evidence[] = [];
      let unresolved = 0;
      for (const pair of relevant) {
        const edge =
          pair.properties.get('border-color') ??
          pair.properties.get('outline-color') ??
          pair.properties.get('border');
        const background =
          pair.properties.get('background-color') ?? pair.properties.get('background');
        const edgeColor =
          parseColor(edge?.value ?? '') ??
          parseColor(edge?.value.trim().split(/\s+/u).at(-1) ?? '');
        const backgroundColor = parseColor(background?.value ?? '');
        if (edgeColor === null || backgroundColor === null) unresolved += 1;
        else if (contrast(edgeColor, backgroundColor) < 3)
          issues.push({
            ...(edge === undefined ? {} : { path: edge.path }),
            range: edge?.range ?? zeroRange,
            message: 'Resolved control or focus contrast is below 3:1.',
            observed: `${edge?.value ?? ''} on ${background?.value ?? ''}`
          });
      }
      if (issues.length > 0) return failed(issues);
      return unresolved > 0
        ? cantTell(
            'One or more non-text color pairs cannot be resolved from source.',
            `${unresolved} unresolved pair(s)`,
            relevant[0]?.properties.values().next().value?.range ?? zeroRange,
            relevant[0]?.properties.values().next().value?.path
          )
        : passed();
    }
    case 'H5A-CSS-005': {
      const minimum = page.kind === null ? 24 : 44;
      const controls = elements(page).filter((element) =>
        ['button', 'a', 'input', 'select', 'textarea'].includes(element.tagName)
      );
      if (controls.length === 0) return inapplicable();
      const mainIds = new Set(
        elements(page, 'main')
          .map((element) => attribute(element, 'id'))
          .filter((value): value is string => value !== undefined)
      );
      const exceptions = controls.filter(
        (element) =>
          element.tagName === 'a' &&
          visible(element) &&
          (attribute(element, 'href')?.startsWith('#') ?? false) &&
          mainIds.has((attribute(element, 'href') ?? '').slice(1)) &&
          elements(page, 'a').filter((candidate) => candidate.parentIndex === element.parentIndex)
            .length === 1
      );
      const sizedControls = controls.filter((control) => !exceptions.includes(control));
      if (sizedControls.length === 0) return passed();
      const bad: CssDeclaration[] = [];
      const unproved: HtmlElement[] = [];
      for (const control of sizedControls) {
        const matching = decls.filter(
          (declaration) =>
            ['width', 'height', 'min-width', 'min-height'].includes(declaration.property) &&
            declaration.atRuleContext.length === 0 &&
            selectorMayMatch(declaration.selector, control, all)
        );
        const scopes = new Set(
          matching.map((declaration) => `${declaration.path}\0${declaration.selector}`)
        );
        if (scopes.size > 1) {
          unproved.push(control);
          continue;
        }
        const dimension = (axis: 'width' | 'height'): 'passed' | 'failed' | 'unknown' => {
          const minimum = matching
            .filter((declaration) => declaration.property === `min-${axis}`)
            .at(-1);
          const size = matching.filter((declaration) => declaration.property === axis).at(-1);
          if (
            pixelAtLeast(minimum, page.kind === null ? 24 : 44) ||
            pixelAtLeast(size, page.kind === null ? 24 : 44)
          )
            return 'passed';
          const exact = minimum ?? size;
          if (
            exact !== undefined &&
            /^\d+(?:\.\d+)?px$/u.test(exact.value.trim()) &&
            Number.parseFloat(exact.value) < (page.kind === null ? 24 : 44)
          ) {
            bad.push(exact);
            return 'failed';
          }
          return 'unknown';
        };
        const width = dimension('width');
        const height = dimension('height');
        if (width === 'unknown' || height === 'unknown') unproved.push(control);
      }
      if (bad.length > 0)
        return failed(
          bad.map((declaration) => ({
            path: declaration.path,
            range: declaration.range,
            message: `A statically sized control dimension is below ${minimum} CSS pixels.`,
            observed: `${declaration.property}:${declaration.value}`
          }))
        );
      return unproved.length === 0
        ? passed()
        : cantTell(
            `Rendered ${minimum} CSS-pixel target size and spacing cannot be proven for every target.`,
            `${unproved.length} control(s) without a per-target size or spacing exception`,
            unproved[0]?.range ?? zeroRange
          );
    }
    case 'H5A-CSS-006': {
      const motion = decls.filter(
        (declaration) =>
          ['animation', 'animation-name', 'transition', 'transition-duration'].includes(
            declaration.property
          ) && !/^(?:none|0(?:ms|s)?)/iu.test(declaration.value)
      );
      if (motion.length === 0) return inapplicable();
      const uncovered = motion.filter((declaration) => !reducedMotionCovers(page, declaration));
      return uncovered.length === 0
        ? passed()
        : failed(
            uncovered.map((declaration) => ({
              path: declaration.path,
              range: declaration.range,
              message:
                'Each non-essential motion needs a matching prefers-reduced-motion reduction.',
              observed: `${declaration.selector}{${declaration.property}:${declaration.value}}`
            }))
          );
    }
    case 'H5A-CSS-007': {
      const disabling = decls.filter(
        (declaration) =>
          declaration.property === 'forced-color-adjust' &&
          declaration.value.trim().toLowerCase() === 'none' &&
          !declaration.atRuleContext.some((context) => /forced-colors\s*:\s*active/iu.test(context))
      );
      if (disabling.length > 0)
        return failed(
          disabling.map((declaration) => ({
            path: declaration.path,
            range: declaration.range,
            message: 'forced-color-adjust:none requires a reviewed forced-colors replacement.',
            observed: `${declaration.selector}{forced-color-adjust:none}`
          }))
        );
      const custom = decls.filter(
        (declaration) =>
          /button|input|status|focus/iu.test(declaration.selector) &&
          [
            'color',
            'background',
            'background-color',
            'border',
            'border-color',
            'box-shadow',
            'outline'
          ].includes(declaration.property)
      );
      if (custom.length === 0) return inapplicable();
      const uncovered = custom.filter((declaration) => !forcedColorsCovers(page, declaration));
      return uncovered.length === 0
        ? passed()
        : cantTell(
            'One or more custom control or status selectors lack matching forced-colors evidence.',
            `${uncovered.length} uncovered declaration(s)`,
            uncovered[0]?.range ?? zeroRange,
            uncovered[0]?.path
          );
    }
    case 'H5A-CSS-008': {
      const widths = decls.filter((declaration) => {
        if (!['width', 'min-width', 'max-width'].includes(declaration.property)) return false;
        const smallControlDimension =
          /(?:button|input|select|textarea)/iu.test(declaration.selector) &&
          /^(?:2[4-9]|[3-4]\d)px$/u.test(declaration.value.trim());
        return !smallControlDimension;
      });
      if (widths.length === 0) return inapplicable();
      const bad = widths.filter((declaration) => {
        const pixels = /^(\d+(?:\.\d+)?)px$/u.exec(declaration.value.trim());
        return (
          declaration.property === 'min-width' &&
          pixels !== null &&
          Number(pixels[1]) > 320 &&
          declaration.atRuleContext.length === 0
        );
      });
      if (bad.length > 0)
        return failed(
          bad.map((declaration) => ({
            path: declaration.path,
            range: declaration.range,
            message: 'An unconditional minimum width exceeds the 320 CSS-pixel reflow viewport.',
            observed: `${declaration.selector}{${declaration.property}:${declaration.value}}`
          }))
        );
      const wideIntrinsic = all.filter(
        (element) =>
          ['canvas', 'embed', 'iframe', 'img', 'object', 'table', 'video'].includes(
            element.tagName
          ) && Number(attribute(element, 'width') ?? '0') > 320
      );
      const nonWrapping = decls.filter(
        (declaration) =>
          declaration.property === 'white-space' &&
          /^(?:nowrap|pre)$/iu.test(declaration.value.trim())
      );
      const preformatted = elements(page, 'pre').filter(
        (element) =>
          !decls.some(
            (declaration) =>
              selectorMayMatch(declaration.selector, element, all) &&
              declaration.property === 'white-space' &&
              /^(?:break-spaces|pre-wrap)$/iu.test(declaration.value.trim())
          )
      );
      const longToken = all.find((element) => /\S{81}/u.test(element.text));
      const risk = wideIntrinsic[0] ?? preformatted[0];
      if (risk !== undefined || nonWrapping.length > 0 || longToken !== undefined) {
        const declaration = nonWrapping[0];
        return cantTell(
          'Intrinsic or non-wrapping content prevents an exact source-only reflow proof.',
          declaration === undefined
            ? `<${(risk ?? longToken)?.tagName ?? 'content'}> overflow risk`
            : `${declaration.selector}{white-space:${declaration.value}}`,
          declaration?.range ?? risk?.range ?? longToken?.range ?? zeroRange,
          declaration?.path
        );
      }
      const provable =
        widths.every((declaration) => declaration.atRuleContext.length === 0) &&
        widths.every(
          (declaration) =>
            declaration.property === 'max-width' &&
            /^(?:100%|(?:[0-2]?\d?\d|320)px)$/u.test(declaration.value.trim())
        ) &&
        decls.some(
          (declaration) =>
            declaration.atRuleContext.length === 0 &&
            declaration.property === 'overflow-wrap' &&
            /(?:anywhere|break-word)/iu.test(declaration.value)
        );
      return provable
        ? passed()
        : cantTell(
            'Source-only cascade and layout evidence cannot prove 320 CSS-pixel reflow.',
            `${widths.length} authored width declaration(s)`,
            widths[0]?.range ?? zeroRange,
            widths[0]?.path
          );
    }
    case 'H5A-CSS-009': {
      const physical = decls.filter((declaration) =>
        /^(?:margin|padding|border)-(?:left|right)|^(?:left|right)$/u.test(declaration.property)
      );
      if (physical.length > 0)
        return failed(
          physical.map((declaration) => ({
            path: declaration.path,
            range: declaration.range,
            message: 'Use a logical property for direction-sensitive layout.',
            observed: declaration.property,
            certainty: 'heuristic'
          }))
        );
      return decls.some((declaration) => /-(?:inline|block)(?:-|$)/u.test(declaration.property))
        ? passed()
        : inapplicable();
    }
    case 'H5A-CSS-010': {
      const containers = decls.filter((declaration) =>
        ['container', 'container-name', 'container-type'].includes(declaration.property)
      );
      const responsive = page.css
        .flatMap((sheet) => sheet.atRules)
        .filter((atRule) => atRule.name === 'media');
      if (containers.length > 0) return passed();
      if (responsive.length === 0) return inapplicable();
      const marked = elements(page).some(
        (element) => attribute(element, 'data-container-adaptive') !== undefined
      );
      const firstResponsive = responsive[0];
      return marked
        ? failed([
            {
              ...(firstResponsive === undefined ? {} : { path: firstResponsive.path }),
              range: firstResponsive?.range ?? zeroRange,
              message:
                'A component marked as container-adaptive uses a viewport media query without a container.',
              observed: firstResponsive?.params ?? ''
            }
          ])
        : cantTell(
            'Static source cannot determine whether viewport or component width should control this design.',
            `${responsive.length} media query/queryies`,
            firstResponsive?.range ?? zeroRange,
            firstResponsive?.path
          );
    }
    default:
      return inapplicable();
  }
};

const checkSafety = (
  ruleId: string,
  page: PageRecord,
  graph: DocumentGraph,
  policy: PolicyPack,
  manifest: PageManifest | null
): CheckResult => {
  const refs = referencesFor(graph, page);
  const all = elements(page);
  const referenceIsRuntime = (reference: ReferenceEvidence): boolean => {
    if (reference.elementIndex === null) return ['@import', 'url()'].includes(reference.attribute);
    const element = all[reference.elementIndex];
    if (element === undefined) return false;
    if (element.tagName === 'link') {
      const rel = (attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/u);
      return rel.some((token) =>
        [
          'stylesheet',
          'icon',
          'preload',
          'modulepreload',
          'manifest',
          'prefetch',
          'preconnect',
          'dns-prefetch'
        ].includes(token)
      );
    }
    if (element.tagName === 'input')
      return attribute(element, 'type')?.toLowerCase() === 'image' && reference.attribute === 'src';
    if (
      element.tagName === 'meta' &&
      (attribute(element, 'http-equiv') ?? '').toLowerCase() === 'refresh'
    )
      return reference.attribute === 'content';
    if (['feimage', 'image', 'use'].includes(element.tagName.toLowerCase()))
      return ['href', 'xlink:href'].includes(reference.attribute);
    return [
      'script',
      'img',
      'source',
      'track',
      'video',
      'audio',
      'iframe',
      'embed',
      'object'
    ].includes(element.tagName);
  };
  switch (ruleId) {
    case 'H5A-SAFE-001': {
      const runtime = refs.filter(
        (reference) => reference.kind === 'remote' && referenceIsRuntime(reference)
      );
      const srcdocRemote = elements(page, 'iframe').filter((iframe) =>
        /\b(?:src|srcset|href|poster|data)\s*=\s*(?:["']\s*)?(?:https?:)?\/\//iu.test(
          attribute(iframe, 'srcdoc') ?? ''
        )
      );
      if (srcdocRemote.length > 0)
        return failed(
          srcdocRemote.map((iframe) => ({
            range: attributeRange(iframe, 'srcdoc'),
            message: 'Embedded srcdoc content declares a remote runtime resource.',
            observed: attribute(iframe, 'srcdoc') ?? ''
          }))
        );
      if (runtime.length > 0)
        return failed(
          runtime.map((reference) => ({
            ...(reference.elementIndex === null ? { path: reference.sourcePath } : {}),
            range: reference.range,
            message: 'Production CFF pages cannot depend on a remote runtime resource.',
            observed: reference.value
          }))
        );
      const unresolvedSrcdoc = elements(page, 'iframe').find(
        (iframe) => attribute(iframe, 'srcdoc') !== undefined
      );
      if (unresolvedSrcdoc !== undefined)
        return cantTell(
          'Nested srcdoc resource resolution is not fully modeled by the static graph.',
          'iframe[srcdoc]',
          attributeRange(unresolvedSrcdoc, 'srcdoc')
        );
      const dataHtml = elements(page, 'iframe').find((iframe) =>
        /^data:text\/html(?:[;,]|$)/iu.test(attribute(iframe, 'src') ?? '')
      );
      if (dataHtml !== undefined)
        return cantTell(
          'Embedded data-HTML iframe content requires bounded nested parsing before offline safety can be proved.',
          'iframe[src=data:text/html]',
          attributeRange(dataHtml, 'src')
        );
      const localRuntime = refs.some(
        (reference) => reference.kind === 'local' && referenceIsRuntime(reference)
      );
      return localRuntime ? passed() : inapplicable();
    }
    case 'H5A-SAFE-002': {
      const bad = all.flatMap((element) =>
        Object.keys(element.attributes)
          .filter((name) => /^on[a-z]+$/u.test(name))
          .map((name) => ({ element, name }))
      );
      if (bad.length > 0)
        return failed(
          bad.map(({ element, name }) => ({
            range: attributeRange(element, name),
            message: 'Inline event-handler attributes are forbidden.',
            observed: name
          }))
        );
      return all.some((element) =>
        ['button', 'a', 'input', 'select', 'textarea', 'form'].includes(element.tagName)
      )
        ? passed()
        : inapplicable();
    }
    case 'H5A-SAFE-003': {
      const blank = all.filter(
        (link) =>
          ['a', 'area'].includes(link.tagName) &&
          attribute(link, 'target')?.toLowerCase() === '_blank'
      );
      if (blank.length === 0) return inapplicable();
      const bad = blank.filter(
        (link) =>
          !(attribute(link, 'rel') ?? '')
            .split(/\s+/u)
            .some((token) => ['noopener', 'noreferrer'].includes(token.toLowerCase()))
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((link) => ({
              range: link.range,
              message: 'A target=_blank link needs rel=noopener or noreferrer.',
              observed: attribute(link, 'rel') ?? '(missing)'
            }))
          );
    }
    case 'H5A-SAFE-004': {
      const forms = elements(page, 'form');
      const submitters = all.filter(
        (element) =>
          ['button', 'input'].includes(element.tagName) &&
          attribute(element, 'formaction') !== undefined
      );
      if (forms.length === 0 && submitters.length === 0) return inapplicable();
      const targets = [
        ...forms.map((element) => ({ element, name: 'action' })),
        ...submitters.map((element) => ({ element, name: 'formaction' }))
      ];
      const bad = targets.filter(({ element, name }) => {
        const action = attribute(element, name) ?? '';
        const graphReference = refs.find(
          (reference) => reference.elementIndex === element.index && reference.attribute === name
        );
        return (
          graphReference?.kind === 'remote' ||
          graphReference?.kind === 'invalid' ||
          remotePattern.test(action) ||
          (!policy.allowedFormActions.includes(action) && action !== '')
        );
      });
      return bad.length === 0
        ? passed()
        : failed(
            bad.map(({ element, name }) => ({
              range: attributeRange(element, name),
              message: 'Form action is remote or not declared by policy.',
              observed: attribute(element, name) ?? ''
            }))
          );
    }
    case 'H5A-SAFE-005': {
      const tracking =
        /(?:analytics|telemetry|fingerprint|doubleclick|googletagmanager|advertising|tracking[-_]?pixel|\/ads?(?:[/?#._-]|$))/iu;
      const trackingAttributes = new Set([
        'src',
        'href',
        'action',
        'formaction',
        'data',
        'ping',
        'poster'
      ]);
      const bad = all.flatMap((element) =>
        Object.entries(element.attributes)
          .filter(([name, value]) => trackingAttributes.has(name) && tracking.test(value))
          .map(([name, value]) => ({ element, name, value }))
      );
      const reporting = all.flatMap((element) =>
        ['ping', 'attributionsrc', 'browsingtopics']
          .filter((name) => attribute(element, name) !== undefined)
          .map((name) => ({ element, name, value: attribute(element, name) ?? '' }))
      );
      const cssBad = refs.filter((reference) => tracking.test(reference.value));
      const scriptBad = elements(page, 'script').filter(
        (script) =>
          attribute(script, 'src') === undefined &&
          /\b(?:navigator\s*\.\s*sendBeacon|gtag\s*\(|ga\s*\(|dataLayer\s*\.\s*push|mixpanel\s*\.|posthog\s*\.|amplitude\s*\.)/iu.test(
            script.text
          )
      );
      const evidence = [
        ...bad.map(({ element, name, value }) => ({
          range: attributeRange(element, name),
          message: 'Tracking or advertising reference is forbidden.',
          observed: value
        })),
        ...reporting.map(({ element, name, value }) => ({
          range: attributeRange(element, name),
          message: 'Attribution, browsing-topic, and ping reporting mechanisms are forbidden.',
          observed: `${name}=${value}`
        })),
        ...cssBad.map((reference) => ({
          path: reference.sourcePath,
          range: reference.range,
          message: 'Tracking or advertising CSS reference is forbidden.',
          observed: reference.value
        })),
        ...scriptBad.map((script) => ({
          range: script.range,
          message: 'An inline script invokes a known analytics or telemetry reporting API.',
          observed:
            /navigator\s*\.\s*sendBeacon/iu.exec(script.text)?.[0] ??
            /(?:gtag|ga|dataLayer|mixpanel|posthog|amplitude)/iu.exec(script.text)?.[0] ??
            'reporting API'
        }))
      ];
      if (evidence.length > 0) return failed(evidence);
      return refs.length > 0 || elements(page, 'script').length > 0 ? passed() : inapplicable();
    }
    case 'H5A-SAFE-006': {
      if (page.html.fragment) return inapplicable();
      const metas = elements(page, 'meta').filter(
        (meta) => attribute(meta, 'http-equiv')?.toLowerCase() === 'content-security-policy'
      );
      if (metas.length > 0) {
        const content = attribute(metas[0] as HtmlElement, 'content') ?? '';
        const assessment = assessCsp(content);
        return assessment === 'passed'
          ? passed()
          : assessment === 'failed'
            ? failed([
                {
                  range: (metas[0] as HtmlElement).range,
                  message: 'The supplied CSP permits a remote, wildcard, or unsafe source.',
                  observed: content
                }
              ])
            : cantTell(
                'The supplied CSP contains a source expression this static policy cannot classify exactly.',
                content,
                (metas[0] as HtmlElement).range
              );
      }
      if (graph.deploymentContentSecurityPolicy !== null) {
        const assessment = assessCsp(graph.deploymentContentSecurityPolicy);
        return assessment === 'passed'
          ? passed()
          : assessment === 'failed'
            ? failed([
                {
                  range: zeroRange,
                  message:
                    'The supplied deployment CSP permits a remote, wildcard, or unsafe source.',
                  observed: graph.deploymentContentSecurityPolicy
                }
              ])
            : cantTell(
                'The supplied deployment CSP contains a source expression this static policy cannot classify exactly.',
                graph.deploymentContentSecurityPolicy
              );
      }
      return manifest?.deploymentHeaders === undefined
        ? cantTell('No deployment-header evidence was supplied.', 'deploymentHeaders missing')
        : cantTell(
            'The declared deployment-header file has no Content-Security-Policy value.',
            manifest.deploymentHeaders
          );
    }
    default:
      return inapplicable();
  }
};

const remotePattern = /^(?:https?:)?\/\//iu;

type CspAssessment = 'passed' | 'failed' | 'cantTell';
const assessCsp = (value: string): CspAssessment => {
  const directives = value
    .split(';')
    .map((part) => part.trim().split(/\s+/u).filter(Boolean))
    .filter((part) => part.length > 0);
  const sourceDirectives = directives.filter(
    ([name]) =>
      name === 'default-src' ||
      name?.endsWith('-src') === true ||
      ['base-uri', 'form-action', 'frame-ancestors'].includes(name ?? '')
  );
  const defaults = sourceDirectives.find(([name]) => name === 'default-src');
  if (defaults === undefined || defaults.length < 2) return 'cantTell';
  for (const [name, ...sources] of sourceDirectives) {
    if (sources.length === 0) return 'cantTell';
    for (const source of sources) {
      const normalized = source.toLowerCase();
      if (
        normalized === '*' ||
        /^(?:https?:|\/\/)/u.test(normalized) ||
        normalized === "'unsafe-inline'" ||
        normalized === "'unsafe-eval'"
      )
        return 'failed';
      if (normalized === 'data:' && name !== 'img-src') return 'failed';
      if (
        !["'none'", "'self'", 'data:', 'blob:'].includes(normalized) &&
        !/^'(?:nonce-[^']+|sha(?:256|384|512)-[^']+)'$/u.test(normalized)
      )
        return 'cantTell';
    }
  }
  return 'passed';
};

const isCffPage = (page: PageRecord): boolean => page.kind !== null;
const checkCff = (ruleId: string, page: PageRecord): CheckResult => {
  if (!isCffPage(page)) return inapplicable();
  const all = elements(page);
  switch (ruleId) {
    case 'H5A-CFF-001': {
      const missing = ['header', 'nav', 'main', 'footer'].filter(
        (tag) => elements(page, tag).length === 0
      );
      return missing.length === 0
        ? passed()
        : failed([
            {
              range: zeroRange,
              message: 'The CFF shared shell is incomplete.',
              observed: `missing: ${missing.join(', ')}`
            }
          ]);
    }
    case 'H5A-CFF-002': {
      const header = elements(page, 'header')[0];
      const text = header?.text ?? '';
      const missing = [
        !/(?:HTML5Assay|CanonFlow)/u.test(text) ? 'product name' : '',
        !/\b\d+\.\d+\.\d+\b/u.test(text) ? 'version' : '',
        !/(?:Specified|Preview|Stable|Experimental|Deprecated)/iu.test(text) ? 'status' : '',
        !/(?:authority|static source evidence|non-authoritative)/iu.test(text)
          ? 'authority label'
          : ''
      ].filter((item) => item !== '');
      return missing.length === 0
        ? passed()
        : failed([
            {
              range: header?.range ?? zeroRange,
              message:
                'CFF product identity needs visible product, version, status, and authority terms.',
              observed: `missing: ${missing.join(', ')}`
            }
          ]);
    }
    case 'H5A-CFF-003':
      if (page.kind !== 'playground') return inapplicable();
      return page.html.source.includes('Preview only — non-authoritative')
        ? passed()
        : failed([
            {
              range: zeroRange,
              message: 'The playground needs the exact non-authoritative preview label.',
              observed: '(missing)'
            }
          ]);
    case 'H5A-CFF-004': {
      if (page.kind !== 'results') return inapplicable();
      const text = elements(page, 'main')[0]?.text ?? page.html.source;
      const missing = [
        !/\b(?:Pass|Fail|Inconclusive|ToolFailure)\b/u.test(text) ? 'verdict' : '',
        !/blocking/iu.test(text) ? 'blocking count' : '',
        !/advisory/iu.test(text) ? 'advisory count' : '',
        !/inconclusive/iu.test(text) ? 'inconclusive count' : '',
        !/policy/iu.test(text) ? 'policy identity' : '',
        !/(?:evidence|digest|receipt)/iu.test(text) ? 'evidence identity' : ''
      ].filter((item) => item !== '');
      return missing.length === 0
        ? passed()
        : failed([
            {
              range: elements(page, 'main')[0]?.range ?? zeroRange,
              message:
                'The results page lacks visible verdict, counts, policy, or evidence identity.',
              observed: `missing: ${missing.join(', ')}`
            }
          ]);
    }
    case 'H5A-CFF-005': {
      const findings = all.filter(
        (element) =>
          attribute(element, 'data-finding') !== undefined ||
          /(?:^|\s)finding(?:\s|$)/iu.test(attribute(element, 'class') ?? '')
      );
      if (findings.length === 0) return inapplicable();
      const bad = findings.filter(
        (finding) =>
          !/(?:html5assay|[a-z]+assay)/iu.test(
            `${finding.text} ${attribute(finding, 'data-assay') ?? ''}`
          ) ||
          !/H5A-[A-Z]+-\d{3}/u.test(`${finding.text} ${attribute(finding, 'data-rule-id') ?? ''}`)
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((finding) => ({
              range: finding.range,
              message: 'Displayed finding lacks visible assay or rule identity.',
              observed: finding.text.trim() || '<finding without identity>'
            }))
          );
    }
    case 'H5A-CFF-006': {
      const stateLike = all.filter(
        (element) =>
          /(?:empty|loading|error|unavailable)/iu.test(attribute(element, 'class') ?? '') ||
          attribute(element, 'data-cff-state') !== undefined
      );
      if (stateLike.length === 0) return inapplicable();
      const bad = stateLike.filter(
        (element) =>
          attribute(element, 'data-cff-state') === undefined &&
          !/(?:^|\s)cff-state(?:\s|$)/iu.test(attribute(element, 'class') ?? '')
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((element) => ({
              range: element.range,
              message: 'Use the shared CFF state component structure.',
              observed: attribute(element, 'class') ?? ''
            }))
          );
    }
    case 'H5A-CFF-007': {
      const statuses = all.filter(
        (element) =>
          attribute(element, 'data-status') !== undefined ||
          /(?:pass|fail|inconclusive|toolfailure)/iu.test(attribute(element, 'class') ?? '')
      );
      if (statuses.length === 0) return inapplicable();
      const bad = statuses.filter((element) => {
        const hasText = /(?:Pass|Fail|Inconclusive|ToolFailure)/u.test(element.text);
        const hasShape =
          attribute(element, 'data-status-icon') !== undefined ||
          all.some(
            (candidate) =>
              isDescendant(candidate, element, all) &&
              attribute(candidate, 'aria-hidden') === 'true' &&
              candidate.text.trim() !== ''
          ) ||
          /^[✓×!?]/u.test(element.text.trim());
        return !hasText || !hasShape;
      });
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((element) => ({
              range: element.range,
              message:
                'Status needs exact visible text and a distinct icon or shape in addition to color.',
              observed: element.text.trim() || '(no text)'
            }))
          );
    }
    default:
      return inapplicable();
  }
};

const checkPerformance = (ruleId: string, page: PageRecord, policy: PolicyPack): CheckResult => {
  switch (ruleId) {
    case 'H5A-PERF-001': {
      if (page.html.fragment) return inapplicable();
      const budget =
        page.kind === 'playground' ? policy.pageBudgets.playground : policy.pageBudgets.default;
      return page.initialBytes <= budget
        ? passed()
        : failed([
            {
              range: zeroRange,
              message: 'Initial local page graph exceeds its raw-byte budget.',
              observed: `${page.initialBytes} bytes; budget ${budget}`
            }
          ]);
    }
    case 'H5A-PERF-002': {
      const images = elements(page, 'img');
      if (images.length === 0) return inapplicable();
      const validDimension = (value: string | undefined): boolean =>
        value !== undefined && /^[1-9]\d*$/u.test(value);
      const invalid = images.filter(
        (image) =>
          (attribute(image, 'width') !== undefined && !validDimension(attribute(image, 'width'))) ||
          (attribute(image, 'height') !== undefined && !validDimension(attribute(image, 'height')))
      );
      if (invalid.length > 0)
        return failed(
          invalid.map((image) => ({
            range:
              !validDimension(attribute(image, 'width')) && attribute(image, 'width') !== undefined
                ? attributeRange(image, 'width')
                : attributeRange(image, 'height'),
            message: 'Image dimensions must be positive integer HTML attributes.',
            observed: `width=${attribute(image, 'width') ?? '(missing)'} height=${attribute(image, 'height') ?? '(missing)'}`
          }))
        );
      const missing = images.filter(
        (image) =>
          attribute(image, 'width') === undefined || attribute(image, 'height') === undefined
      );
      if (missing.length === 0) return passed();
      const unresolved = missing.filter(
        (image) =>
          !effectiveDeclarations(page).some(
            (declaration) =>
              selectorMayMatch(declaration.selector, image, page.html.elements) &&
              declaration.atRuleContext.length === 0 &&
              declaration.property === 'aspect-ratio' &&
              /^(?!0+(?:\.0+)?\s*\/)(?:\d+(?:\.\d+)?)\s*\/\s*(?!0+(?:\.0+)?$)(?:\d+(?:\.\d+)?)$/u.test(
                declaration.value.trim()
              )
          )
      );
      return unresolved.length === 0
        ? passed()
        : failed(
            unresolved.map((image) => ({
              range: image.range,
              message:
                'Image lacks intrinsic dimensions and no stable CSS aspect ratio is present.',
              observed: '<img> without width/height'
            }))
          );
    }
    case 'H5A-PERF-003': {
      const images = elements(page, 'img');
      if (images.length === 0) return inapplicable();
      const first = images[0];
      if (first !== undefined && attribute(first, 'loading') === 'lazy')
        return failed([
          {
            range: first.range,
            message: 'The likely principal content image must not load lazily.',
            observed: 'loading=lazy',
            certainty: 'heuristic'
          }
        ]);
      if (
        images.length > 1 &&
        images.slice(1).every((image) => attribute(image, 'loading') === 'lazy')
      )
        return passed();
      return first !== undefined && attribute(first, 'loading') === 'lazy'
        ? failed([
            {
              range: first.range,
              message: 'The likely principal content image must not load lazily.',
              observed: 'loading=lazy',
              certainty: 'heuristic'
            }
          ])
        : cantTell(
            'Source order alone cannot identify the largest-content image or fold position.',
            `${images.length} image(s)`,
            first?.range ?? zeroRange
          );
    }
    case 'H5A-PERF-004': {
      const fontDecls = effectiveDeclarations(page).filter(
        (declaration) => declaration.property === 'font-family'
      );
      const remoteCssFonts = page.css.flatMap((sheet) =>
        sheet.urls.filter(
          (url) =>
            remotePattern.test(url.value) &&
            sheet.atRules.some(
              (atRule) =>
                atRule.name === 'font-face' &&
                url.range.start.offset >= atRule.range.start.offset &&
                url.range.end.offset <= atRule.range.end.offset
            )
        )
      );
      const remoteFonts = page.html.elements.filter(
        (element) =>
          element.tagName === 'link' &&
          /fonts?/iu.test(attribute(element, 'href') ?? '') &&
          remotePattern.test(attribute(element, 'href') ?? '')
      );
      if (remoteFonts.length > 0 || remoteCssFonts.length > 0)
        return failed([
          ...remoteFonts.map((element) => ({
            range: element.range,
            message: 'Required fonts must be local.',
            observed: attribute(element, 'href') ?? ''
          })),
          ...remoteCssFonts.map((url) => ({
            path: url.path,
            range: url.range,
            message: 'Required fonts must be local.',
            observed: url.value
          }))
        ]);
      if (fontDecls.length === 0) return inapplicable();
      const fallback = /(?:system-ui|sans-serif|serif|monospace|ui-sans-serif|ui-monospace)/iu;
      const bad = fontDecls.filter((declaration) => !fallback.test(declaration.value));
      if (bad.length > 0)
        return failed(
          bad.map((declaration) => ({
            path: declaration.path,
            range: declaration.range,
            message: 'Font stack lacks a system or generic fallback.',
            observed: declaration.value
          }))
        );
      const custom = fontDecls.filter(
        (declaration) =>
          !/^(?:system-ui|ui-sans-serif|ui-serif|ui-monospace|sans-serif|serif|monospace)(?:\s*,\s*(?:system-ui|ui-sans-serif|ui-serif|ui-monospace|sans-serif|serif|monospace))*$/iu.test(
            declaration.value.trim()
          )
      );
      return custom.length === 0
        ? passed()
        : cantTell(
            'Custom local fonts need licence and subsetting evidence.',
            `${custom.length} custom font stack(s)`,
            custom[0]?.range ?? zeroRange,
            custom[0]?.path
          );
    }
    case 'H5A-PERF-005': {
      const media = elements(page).filter(
        (element) =>
          ['audio', 'video'].includes(element.tagName) &&
          attribute(element, 'autoplay') !== undefined
      );
      if (media.length === 0) return inapplicable();
      const bad = media.filter((element) => attribute(element, 'muted') === undefined);
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((element) => ({
              range: element.range,
              message: 'Autoplay media must be muted.',
              observed: `<${element.tagName} autoplay>`
            }))
          );
    }
    case 'H5A-PERF-006': {
      const scripts = elements(page, 'script').filter(
        (script) => attribute(script, 'src') !== undefined
      );
      if (scripts.length === 0) return inapplicable();
      const bad = scripts.filter(
        (script) =>
          attribute(script, 'type') !== 'module' &&
          attribute(script, 'defer') === undefined &&
          attribute(script, 'async') === undefined
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((script) => ({
              range: script.range,
              message: 'Non-critical external script blocks parsing; use module or defer.',
              observed: attribute(script, 'src') ?? ''
            }))
          );
    }
    default:
      return inapplicable();
  }
};

const lightTokens: Readonly<Record<string, string>> = {
  '--cf-bg': '#f7f9fb',
  '--cf-surface': '#ffffff',
  '--cf-surface-raised': '#eef3f8',
  '--cf-glass': 'rgba(255, 255, 255, 0.86)',
  '--cf-text': '#17202a',
  '--cf-text-muted': '#4f5d6b',
  '--cf-outline': '#667487',
  '--cf-scrim': 'rgba(23, 32, 42, 0.36)',
  '--cf-primary': '#005ea8',
  '--cf-on-primary': '#ffffff',
  '--cf-primary-container': '#d6eaff',
  '--cf-on-primary-container': '#002f52',
  '--cf-secondary': '#00696f',
  '--cf-on-secondary': '#ffffff',
  '--cf-secondary-container': '#c8f2f3',
  '--cf-on-secondary-container': '#003638',
  '--cf-tertiary': '#6546a3',
  '--cf-on-tertiary': '#ffffff',
  '--cf-tertiary-container': '#e9dfff',
  '--cf-on-tertiary-container': '#271451',
  '--cf-pass': '#176b3a',
  '--cf-check': '#7a4d00',
  '--cf-fail': '#b4232c',
  '--cf-focus': '#005fcc'
};
const darkTokens: Readonly<Record<string, string>> = {
  '--cf-bg': '#0b0f14',
  '--cf-surface': '#121922',
  '--cf-surface-raised': '#182231',
  '--cf-glass': 'rgba(18, 25, 34, 0.84)',
  '--cf-text': '#f2f6fa',
  '--cf-text-muted': '#b7c1cc',
  '--cf-outline': '#748398',
  '--cf-scrim': 'rgba(0, 0, 0, 0.64)',
  '--cf-primary': '#8fc7ff',
  '--cf-on-primary': '#002f52',
  '--cf-primary-container': '#0b3d68',
  '--cf-on-primary-container': '#d6ebff',
  '--cf-secondary': '#68d5d8',
  '--cf-on-secondary': '#003738',
  '--cf-secondary-container': '#114b4e',
  '--cf-on-secondary-container': '#c4f4f4',
  '--cf-tertiary': '#c8b7ff',
  '--cf-on-tertiary': '#30205f',
  '--cf-tertiary-container': '#45377a',
  '--cf-on-tertiary-container': '#e9e1ff',
  '--cf-pass': '#71d79c',
  '--cf-check': '#ffd166',
  '--cf-fail': '#ff8a95',
  '--cf-focus': '#ffbf47'
};
const namedColors = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(
    ' '
  )
);
const rawColorValue = (value: string): boolean => {
  const normalized = value.toLowerCase();
  if (/(?:#[0-9a-f]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\()/u.test(normalized))
    return true;
  return normalized.split(/[^a-z]+/u).some((token) => namedColors.has(token));
};
const checkTheme = (ruleId: string, page: PageRecord): CheckResult => {
  if (!isCffPage(page)) return inapplicable();
  const decls = declarations(page);
  switch (ruleId) {
    case 'H5A-THEME-001': {
      const raw = decls.filter(
        (declaration) =>
          !declaration.property.startsWith('--') &&
          rawColorValue(declaration.value) &&
          !/(?:syntax|illustration|example)/iu.test(declaration.selector) &&
          !declaration.atRuleContext.some((context) => /forced-colors\s*:\s*active/iu.test(context))
      );
      return raw.length === 0
        ? passed()
        : failed(
            raw.map((declaration) => ({
              range: declaration.range,
              message: 'CFF component color must use a semantic theme token.',
              observed: `${declaration.property}:${declaration.value}`
            }))
          );
    }
    case 'H5A-THEME-002': {
      const light = new Map(
        decls
          .filter(
            (declaration) =>
              declaration.property.startsWith('--cf-') && declaration.atRuleContext.length === 0
          )
          .map((declaration) => [declaration.property, declaration])
      );
      const dark = new Map(
        decls
          .filter(
            (declaration) =>
              declaration.property.startsWith('--cf-') &&
              declaration.atRuleContext.some((context) =>
                /prefers-color-scheme\s*:\s*dark/iu.test(context)
              )
          )
          .map((declaration) => [declaration.property, declaration])
      );
      const mismatches = Object.entries(lightTokens)
        .flatMap(([token, expected]) =>
          light.get(token)?.value.toLowerCase() === expected ? [] : [`light ${token}`]
        )
        .concat(
          Object.entries(darkTokens).flatMap(([token, expected]) =>
            dark.get(token)?.value.toLowerCase() === expected ? [] : [`dark ${token}`]
          )
        );
      const colorScheme = decls.some(
        (declaration) =>
          declaration.property === 'color-scheme' && /\blight\s+dark\b/iu.test(declaration.value)
      );
      if (!colorScheme) mismatches.push('color-scheme: light dark');
      return mismatches.length === 0
        ? passed()
        : failed([
            {
              range: zeroRange,
              message: 'CFF Evidence light and dark token values must match cff-evidence/1.0.0.',
              observed: `missing or mismatched: ${mismatches.join(', ')}`
            }
          ]);
    }
    case 'H5A-THEME-003': {
      const uses = decls.filter((declaration) =>
        /var\(--cf-(?:primary|secondary|tertiary)/u.test(declaration.value)
      );
      if (uses.length === 0) return inapplicable();
      const bad = uses.filter(
        (declaration) =>
          /(?:fail|pass|status|verdict|error)/iu.test(declaration.selector) &&
          /var\(--cf-(?:primary|secondary|tertiary)/u.test(declaration.value)
      );
      if (bad.length > 0)
        return failed(
          bad.map((declaration) => ({
            path: declaration.path,
            range: declaration.range,
            message: 'Brand roles cannot substitute for status colors.',
            observed: `${declaration.selector}{${declaration.value}}`
          }))
        );
      const known = uses.every((declaration) =>
        /(?:policy|governance|provenance)/iu.test(declaration.selector)
          ? /var\(--cf-tertiary/u.test(declaration.value)
          : /(?:nav|link|primary|filter|workflow|secondary)/iu.test(declaration.selector)
      );
      return known
        ? passed()
        : cantTell(
            'Static selectors cannot fully prove platform color-role responsibility.',
            `${uses.length} brand-role use(s)`,
            uses[0]?.range ?? zeroRange,
            uses[0]?.path
          );
    }
    case 'H5A-THEME-004': {
      const regions = elements(page).filter(
        (element) => attribute(element, 'data-task-region') !== undefined
      );
      if (regions.length === 0) return inapplicable();
      const bad = regions.filter(
        (region) =>
          elements(page).filter(
            (candidate) =>
              isDescendant(candidate, region, page.html.elements) &&
              attribute(candidate, 'data-action') === 'primary'
          ).length > 1
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((region) => ({
              range: region.range,
              message: 'Task region contains more than one filled primary action.',
              observed: 'multiple data-action=primary controls'
            }))
          );
    }
    case 'H5A-THEME-005': {
      const statusUses = decls.filter((declaration) =>
        /var\(--cf-(?:pass|check|fail)\)/u.test(declaration.value)
      );
      if (statusUses.length === 0) return inapplicable();
      const bad = statusUses.filter(
        (declaration) =>
          !/(?:pass|check|fail|status|verdict|finding|inconclusive|error)/iu.test(
            declaration.selector
          )
      );
      return bad.length === 0
        ? passed()
        : failed(
            bad.map((declaration) => ({
              path: declaration.path,
              range: declaration.range,
              message: 'Status colors are reserved for evidence status.',
              observed: declaration.selector
            }))
          );
    }
    case 'H5A-THEME-006': {
      const gradient = decls.filter((declaration) =>
        /(?:brand-gradient|linear-gradient\(135deg)/iu.test(declaration.value)
      );
      if (gradient.length === 0) return inapplicable();
      const uses = gradient.filter((declaration) => !declaration.property.startsWith('--'));
      const unsafe = uses.filter((declaration) =>
        /button|:focus|status|verdict|finding/u.test(declaration.selector)
      );
      if (unsafe.length > 0)
        return failed(
          unsafe.map((declaration) => ({
            path: declaration.path,
            range: declaration.range,
            message: 'Brand gradient cannot carry control, focus, or status meaning.',
            observed: declaration.selector
          }))
        );
      if (
        uses.length === 0 ||
        uses.every((declaration) => /(?:cff-mark|keyline|aura)/iu.test(declaration.selector))
      )
        return passed();
      return cantTell(
        'The gradient use is not marked as a reviewed decorative mark, keyline, or aura.',
        `${uses.length} use(s)`,
        uses[0]?.range ?? zeroRange,
        uses[0]?.path
      );
    }
    default:
      return inapplicable();
  }
};

const effectiveLevel = (
  ruleId: string,
  defaultLevel: FindingLevel,
  policy: PolicyPack
): FindingLevel | 'off' => policy.levels[ruleId] ?? defaultLevel;
const suppressionFor = (
  ruleId: string,
  path: string,
  suppressions: readonly SuppressionRecord[],
  reviewDate: string
): SuppressionRecord | undefined =>
  suppressions.find(
    (suppression) =>
      suppression.ruleId === ruleId &&
      (suppression.path === undefined || suppression.path === path) &&
      suppression.expires >= reviewDate
  );

export const evaluateRules = (
  graph: DocumentGraph,
  policy: PolicyPack,
  manifest: PageManifest | null
): EvaluationBundle => {
  const findings: Finding[] = [];
  const evaluations: RuleEvaluation[] = [];
  const suppressions = [...policy.suppressions, ...(manifest?.approvedSuppressions ?? [])];
  for (const page of graph.pages) {
    for (const rule of ruleCatalog) {
      const level = effectiveLevel(rule.id, rule.defaultLevel, policy);
      if (level === 'off') {
        evaluations.push({
          ruleId: rule.id,
          ruleVersion: rule.version,
          path: page.path,
          outcome: 'untested',
          level: rule.defaultLevel,
          findingCount: 0
        });
        continue;
      }
      const family = rule.family;
      const result =
        family === 'DOC'
          ? checkDocument(rule.id, page, graph)
          : family === 'SEM'
            ? checkSemantics(rule.id, page)
            : family === 'A11Y'
              ? checkA11y(rule.id, page, graph)
              : family === 'CSS'
                ? checkCss(rule.id, page)
                : family === 'SAFE'
                  ? checkSafety(rule.id, page, graph, policy, manifest)
                  : family === 'CFF'
                    ? checkCff(rule.id, page)
                    : family === 'PERF'
                      ? checkPerformance(rule.id, page, policy)
                      : family === 'THEME'
                        ? checkTheme(rule.id, page)
                        : { outcome: 'untested' as const };
      const evidence = result.evidence ?? [];
      evaluations.push({
        ruleId: rule.id,
        ruleVersion: rule.version,
        path: page.path,
        outcome: result.outcome,
        level,
        findingCount: evidence.length
      });
      for (const item of evidence) {
        const findingPath = item.path ?? page.path;
        const suppression = suppressionFor(rule.id, findingPath, suppressions, policy.reviewDate);
        const observedDigest = digest(
          `${rule.id}\0${findingPath}\0${item.range.start.offset}\0${item.observed}`
        );
        findings.push({
          ruleId: rule.id,
          ruleVersion: rule.version,
          authority: rule.authority,
          level,
          certainty: item.certainty ?? (result.outcome === 'cantTell' ? 'contextual' : 'exact'),
          outcome: result.outcome === 'cantTell' ? 'cantTell' : 'failed',
          path: findingPath,
          range: item.range,
          message: item.message,
          observed: item.observed,
          expected: rule.expectations.join(' '),
          remediation: `Change the source to meet ${rule.id}; then rerun HTML5Assay.`,
          standards: rule.standards,
          evidenceDigest: observedDigest,
          ...(suppression === undefined
            ? {}
            : {
                suppression: {
                  suppressed: true,
                  owner: suppression.owner,
                  reason: suppression.reason,
                  expires: suppression.expires
                }
              })
        });
      }
    }
  }
  return { evaluations, findings };
};
