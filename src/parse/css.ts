import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { rangeAt } from './location.js';
import type { CssDeclaration, CssRuleRecord, ParsedCss } from './types.js';

const absoluteOffset = (
  source: string,
  line: number | undefined,
  column: number | undefined
): number => {
  if (line === undefined || column === undefined) return 0;
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const next = source.indexOf('\n', offset);
    if (next < 0) return source.length;
    offset = next + 1;
    currentLine += 1;
  }
  return Math.min(source.length, offset + column - 1);
};

const atRuleParents = (node: Rule | Declaration): readonly string[] => {
  const contexts: string[] = [];
  interface ParentLike {
    readonly type: string;
    readonly name?: string;
    readonly params?: string;
    readonly parent?: ParentLike;
  }
  let parent = node.parent as unknown as ParentLike | undefined;
  while (parent !== undefined) {
    if (parent.type === 'atrule')
      contexts.unshift(`@${parent.name ?? ''} ${parent.params ?? ''}`.trim());
    parent = parent.parent;
  }
  return contexts;
};

const nodeOffsets = (
  source: string,
  node: Rule | Declaration | AtRule
): readonly [number, number] => {
  const start = absoluteOffset(source, node.source?.start?.line, node.source?.start?.column);
  const end = absoluteOffset(source, node.source?.end?.line, node.source?.end?.column) + 1;
  return [start, Math.max(start, Math.min(source.length, end))];
};

export const parseCss = (
  path: string,
  source: string,
  baseOffset = 0,
  hostSource = source
): ParsedCss => {
  const evidencePath = path.replace(/#style-\d+$/u, '');
  const root = postcss.parse(source, { from: undefined });
  const rules: CssRuleRecord[] = [];
  const atRules: ParsedCss['atRules'][number][] = [];
  const urls: ParsedCss['urls'][number][] = [];
  root.walkAtRules((atRule) => {
    const [start, end] = nodeOffsets(source, atRule);
    atRules.push({
      path: evidencePath,
      name: atRule.name.toLowerCase(),
      params: atRule.params,
      range: rangeAt(hostSource, baseOffset + start, baseOffset + end)
    });
    if (atRule.name.toLowerCase() === 'import') {
      const match = /(?:url\()?\s*["']?([^"')\s]+)["']?/.exec(atRule.params);
      if (match?.[1] !== undefined)
        urls.push({
          path: evidencePath,
          value: match[1],
          kind: 'import',
          range: rangeAt(hostSource, baseOffset + start, baseOffset + end)
        });
    }
  });
  root.walkComments((comment) => {
    const match = /[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/iu.exec(comment.text);
    if (match?.[1] !== undefined) {
      const start = absoluteOffset(
        source,
        comment.source?.start?.line,
        comment.source?.start?.column
      );
      const end =
        absoluteOffset(source, comment.source?.end?.line, comment.source?.end?.column) + 1;
      urls.push({
        path: evidencePath,
        value: match[1],
        kind: 'source-map',
        range: rangeAt(hostSource, baseOffset + start, baseOffset + end)
      });
    }
  });
  root.walkRules((rule) => {
    const declarations: CssDeclaration[] = [];
    rule.walkDecls((declaration) => {
      const [start, end] = nodeOffsets(source, declaration);
      declarations.push({
        path: evidencePath,
        property: declaration.prop.toLowerCase(),
        value: declaration.value,
        important: declaration.important,
        range: rangeAt(hostSource, baseOffset + start, baseOffset + end),
        selector: rule.selector,
        atRuleContext: atRuleParents(declaration)
      });
    });
    const [start, end] = nodeOffsets(source, rule);
    rules.push({
      path: evidencePath,
      selector: rule.selector,
      range: rangeAt(hostSource, baseOffset + start, baseOffset + end),
      declarations,
      atRuleContext: atRuleParents(rule)
    });
  });
  root.walkDecls((declaration) => {
    const [start, end] = nodeOffsets(source, declaration);
    for (const match of declaration.value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
      if (match[1] !== undefined)
        urls.push({
          path: evidencePath,
          value: match[1].trim(),
          kind: 'url',
          range: rangeAt(hostSource, baseOffset + start, baseOffset + end)
        });
    }
  });
  return { path, source, rules, atRules, urls };
};
