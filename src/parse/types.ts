import type { SourceRange } from '../api/model.js';

export interface HtmlAttribute {
  readonly name: string;
  readonly value: string;
  readonly range: SourceRange;
}

export interface HtmlElement {
  readonly index: number;
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly attributeLocations: Readonly<Record<string, SourceRange>>;
  readonly range: SourceRange;
  readonly parentIndex: number | null;
  readonly directText: string;
  readonly text: string;
}

export interface HtmlParseError {
  readonly code: string;
  readonly range: SourceRange;
}

export interface EmbeddedStyle {
  readonly source: string;
  readonly baseOffset: number;
  readonly elementIndex: number;
}

export interface ParsedHtml {
  readonly path: string;
  readonly source: string;
  readonly fragment: boolean;
  readonly elements: readonly HtmlElement[];
  readonly parseErrors: readonly HtmlParseError[];
  readonly embeddedStyles: readonly EmbeddedStyle[];
  readonly nodeCount: number;
}

export interface CssDeclaration {
  readonly path: string;
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly range: SourceRange;
  readonly selector: string;
  readonly atRuleContext: readonly string[];
}

export interface CssRuleRecord {
  readonly path: string;
  readonly selector: string;
  readonly range: SourceRange;
  readonly declarations: readonly CssDeclaration[];
  readonly atRuleContext: readonly string[];
}

export interface ParsedCss {
  readonly path: string;
  readonly source: string;
  readonly rules: readonly CssRuleRecord[];
  readonly atRules: readonly {
    readonly path: string;
    readonly name: string;
    readonly params: string;
    readonly range: SourceRange;
  }[];
  readonly urls: readonly {
    readonly value: string;
    readonly kind: 'import' | 'url' | 'source-map';
    readonly path: string;
    readonly range: SourceRange;
  }[];
}
