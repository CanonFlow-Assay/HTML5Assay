import {
  defaultTreeAdapter,
  html as parse5Html,
  parse,
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError
} from 'parse5';
import type { SourceRange } from '../api/model.js';
import { rangeAt, zeroRange } from './location.js';
import type { EmbeddedStyle, HtmlElement, HtmlParseError, ParsedHtml } from './types.js';

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ElementNode = DefaultTreeAdapterTypes.Element;

const isElement = (node: ChildNode): node is ElementNode => 'tagName' in node;

const sourceRange = (
  source: string,
  location: { readonly startOffset: number; readonly endOffset: number } | null | undefined
): SourceRange =>
  location === null || location === undefined
    ? zeroRange()
    : rangeAt(source, location.startOffset, location.endOffset);

const nodeText = (node: ParentNode | ChildNode): string => {
  if ('value' in node) return node.value;
  if ('childNodes' in node) return node.childNodes.map(nodeText).join(' ');
  return '';
};

const directNodeText = (node: ParentNode): string =>
  'childNodes' in node
    ? node.childNodes.map((child) => ('value' in child ? child.value : '')).join(' ')
    : '';

const namespaceFor = (namespace: 'html' | 'svg' | 'mathml' | undefined): parse5Html.NS => {
  if (namespace === 'svg') return parse5Html.NS.SVG;
  if (namespace === 'mathml') return parse5Html.NS.MATHML;
  return parse5Html.NS.HTML;
};

export interface FragmentContext {
  readonly contextElement: string;
  readonly contextNamespace?: 'html' | 'svg' | 'mathml';
}

export const parseHtml = (
  path: string,
  source: string,
  fragmentContext?: FragmentContext
): ParsedHtml => {
  const errors: HtmlParseError[] = [];
  const onParseError = (error: ParserError): void => {
    errors.push({ code: error.code, range: rangeAt(source, error.startOffset, error.endOffset) });
  };
  const options = { sourceCodeLocationInfo: true, onParseError } as const;
  let root: ParentNode;
  if (fragmentContext === undefined) root = parse(source, options);
  else {
    const context = defaultTreeAdapter.createElement(
      fragmentContext.contextElement.toLowerCase(),
      namespaceFor(fragmentContext.contextNamespace),
      []
    );
    root = parseFragment(context, source, options);
  }

  const elements: HtmlElement[] = [];
  const embeddedStyles: EmbeddedStyle[] = [];
  let nodeCount = 0;
  const visit = (node: ParentNode | ChildNode, parentIndex: number | null): void => {
    nodeCount += 1;
    let nextParent = parentIndex;
    if (
      'nodeName' in node &&
      node.nodeName !== '#document' &&
      node.nodeName !== '#document-fragment' &&
      isElement(node as ChildNode)
    ) {
      const element = node as ElementNode;
      const index = elements.length;
      const attributes = Object.fromEntries(
        element.attrs.map((attribute) => [attribute.name, attribute.value])
      );
      const attributeLocations = Object.fromEntries(
        Object.entries(element.sourceCodeLocation?.attrs ?? {}).map(([name, location]) => [
          name,
          sourceRange(source, location)
        ])
      );
      elements.push({
        index,
        tagName: element.tagName,
        attributes,
        attributeLocations,
        range: sourceRange(source, element.sourceCodeLocation),
        parentIndex,
        directText: directNodeText(element),
        text: nodeText(element)
      });
      nextParent = index;
      if (element.tagName === 'style') {
        const styleSource = nodeText(element);
        const start =
          element.sourceCodeLocation?.startTag?.endOffset ??
          element.sourceCodeLocation?.startOffset ??
          0;
        embeddedStyles.push({ source: styleSource, baseOffset: start, elementIndex: index });
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child, nextParent);
    }
  };
  visit(root, null);
  return {
    path,
    source,
    fragment: fragmentContext !== undefined,
    elements,
    parseErrors: errors,
    embeddedStyles,
    nodeCount
  };
};
