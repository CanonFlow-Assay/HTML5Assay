import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import type { Digest, PageManifest, PolicyPack, ResourceLimit, SourceRange } from '../api/model.js';
import { parseCss } from '../parse/css.js';
import { parseHtml } from '../parse/html.js';
import type { ParsedCss, ParsedHtml } from '../parse/types.js';
import { digest } from '../result/canonical.js';
import type { AssetRecord, DocumentGraph, PageRecord, ReferenceEvidence } from './model.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const remotePattern = /^(?:https?:)?\/\//iu;
const otherSchemePattern = /^[a-z][a-z0-9+.-]*:/iu;
const normalizePath = (path: string): string => path.split(sep).join('/');

const insideRoot = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

const decodeText = (bytes: Uint8Array, path: string): string => {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`Required text input is not valid UTF-8: ${path}`);
  }
};

const hashSubject = (assets: readonly AssetRecord[]): Digest =>
  digest(
    assets
      .slice()
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((asset) => `${asset.path}\0${asset.digest.value}\0${asset.bytes}\n`)
      .join('')
  );

const attrRange = (html: ParsedHtml, elementIndex: number, name: string): SourceRange => {
  const element = html.elements[elementIndex];
  return (
    element?.attributeLocations[name] ??
    element?.range ?? {
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 0, line: 1, column: 1 }
    }
  );
};

const preflightHtmlNodes = (source: string, limit: number): number => {
  let observed = 4;
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<[^>]*>|[^<]+/gu)) {
    const token = match[0];
    observed +=
      token.startsWith('</') || token.startsWith('<!')
        ? 0
        : token.startsWith('<')
          ? 1
          : token.trim() === ''
            ? 0
            : 1;
    if (observed > limit) return observed;
  }
  return observed;
};

const preflightCssRules = (source: string, remaining: number): number => {
  let count = 0;
  for (const character of source) {
    if (character === '{') count += 1;
    if (count > remaining) return count;
  }
  return count;
};

const excluded = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => {
    const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//u, '');
    if (normalized.endsWith('/**'))
      return path === normalized.slice(0, -3) || path.startsWith(normalized.slice(0, -2));
    return path === normalized;
  });

const inAssetRoots = (path: string, roots: readonly string[]): boolean =>
  roots.length === 0 ||
  roots.some((root) => {
    const normalized = root.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
    return path === normalized || path.startsWith(`${normalized}/`);
  });

interface BuildGraphOptions {
  readonly root: string;
  readonly entries: readonly string[];
  readonly manifest: PageManifest | null;
  readonly policy: PolicyPack;
}

interface LoadedAsset {
  readonly record: AssetRecord;
  readonly bytes: Uint8Array;
}

export class GraphBuildFailure extends Error {
  readonly code: string;
  readonly subjectDigest: Digest;

  constructor(code: string, subjectDigest: Digest) {
    super(code);
    this.name = 'GraphBuildFailure';
    this.code = code;
    this.subjectDigest = subjectDigest;
  }
}

export const buildGraph = async (options: BuildGraphOptions): Promise<DocumentGraph> => {
  const root = await realpath(options.root);
  const assets: AssetRecord[] = [];
  const references: ReferenceEvidence[] = [];
  const limits: ResourceLimit[] = [];
  const incompleteReasons: string[] = [];
  const byteCache = new Map<string, Uint8Array>();
  const recordCache = new Map<string, AssetRecord>();
  let totalBytes = 0;
  try {
    const loadAsset = async (
      absolutePath: string,
      path: string,
      kind: AssetRecord['kind'],
      depth: number
    ): Promise<LoadedAsset | null> => {
      const cachedRecord = recordCache.get(path);
      const cachedBytes = byteCache.get(path);
      if (cachedRecord !== undefined && cachedBytes !== undefined)
        return { record: cachedRecord, bytes: cachedBytes };
      const metadata = await stat(absolutePath);
      if (!metadata.isFile()) throw new Error(`${path} is not a file`);
      if (assets.length + 1 > options.policy.limits.inputFiles) {
        limits.push({
          id: 'inputFiles',
          limit: options.policy.limits.inputFiles,
          observed: assets.length + 1,
          path
        });
        incompleteReasons.push(`Input-file limit prevented reading ${path}`);
        return null;
      }
      if (
        (kind === 'html' || kind === 'css') &&
        metadata.size > options.policy.limits.bytesPerTextFile
      ) {
        limits.push({
          id: 'bytesPerTextFile',
          limit: options.policy.limits.bytesPerTextFile,
          observed: metadata.size,
          path
        });
        incompleteReasons.push(`Per-text-file byte limit prevented reading ${path}`);
        return null;
      }
      if (totalBytes + metadata.size > options.policy.limits.totalAnalyzedBytes) {
        limits.push({
          id: 'totalAnalyzedBytes',
          limit: options.policy.limits.totalAnalyzedBytes,
          observed: totalBytes + metadata.size,
          path
        });
        incompleteReasons.push(`Total byte limit prevented reading ${path}`);
        return null;
      }
      const bytes = await readFile(absolutePath);
      const record: AssetRecord = {
        path,
        bytes: bytes.byteLength,
        digest: digest(bytes),
        kind,
        depth
      };
      assets.push(record);
      totalBytes += bytes.byteLength;
      recordCache.set(path, record);
      byteCache.set(path, bytes);
      return { record, bytes };
    };

    const resolveReference = async (
      sourcePath: string,
      elementIndex: number | null,
      attribute: string,
      value: string,
      range: SourceRange,
      depth: number,
      readKind: AssetRecord['kind'] | null,
      resolutionValue = value
    ): Promise<LoadedAsset | null> => {
      const trimmed = resolutionValue.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        references.push({
          sourcePath,
          elementIndex,
          attribute,
          value,
          kind: 'embedded',
          resolvedPath: null,
          range
        });
        return null;
      }
      if (remotePattern.test(trimmed)) {
        references.push({
          sourcePath,
          elementIndex,
          attribute,
          value,
          kind: 'remote',
          resolvedPath: null,
          range
        });
        return null;
      }
      if (otherSchemePattern.test(trimmed)) {
        references.push({
          sourcePath,
          elementIndex,
          attribute,
          value,
          kind: 'invalid',
          resolvedPath: null,
          range
        });
        return null;
      }
      const withoutQuery = trimmed.split(/[?#]/u, 1)[0] ?? '';
      const candidate = withoutQuery.startsWith('/')
        ? resolve(root, `.${withoutQuery}`)
        : resolve(root, dirname(sourcePath), withoutQuery);
      if (!insideRoot(root, candidate)) {
        references.push({
          sourcePath,
          elementIndex,
          attribute,
          value,
          kind: 'escape',
          resolvedPath: null,
          range
        });
        return null;
      }
      if (depth > options.policy.limits.localReferenceDepth) {
        const path = normalizePath(relative(root, candidate));
        limits.push({
          id: 'localReferenceDepth',
          limit: options.policy.limits.localReferenceDepth,
          observed: depth,
          path
        });
        incompleteReasons.push(`Reference-depth limit prevented reading ${path}`);
        return null;
      }
      // Navigation and form-action URLs are inert graph evidence, not files that
      // the assay needs to open. A same-root route remains local even when there
      // is no corresponding static file on disk.
      if (readKind === null) {
        const path = normalizePath(relative(root, candidate));
        references.push({
          sourcePath,
          elementIndex,
          attribute,
          value,
          kind: 'local',
          resolvedPath: path,
          range
        });
        return null;
      }
      let canonical: string;
      try {
        // realpath resolves every symlinked parent, closing parent-directory escape paths.
        canonical = await realpath(candidate);
      } catch {
        const path = normalizePath(relative(root, candidate));
        references.push({
          sourcePath,
          elementIndex,
          attribute,
          value,
          kind: 'missing',
          resolvedPath: path,
          range
        });
        incompleteReasons.push(`Referenced local file is unavailable: ${path}`);
        return null;
      }
      if (!insideRoot(root, canonical)) {
        references.push({
          sourcePath,
          elementIndex,
          attribute,
          value,
          kind: 'escape',
          resolvedPath: null,
          range
        });
        return null;
      }
      const path = normalizePath(relative(root, canonical));
      if (readKind !== null && !inAssetRoots(path, options.manifest?.localAssetRoots ?? [])) {
        references.push({
          sourcePath,
          elementIndex,
          attribute,
          value,
          kind: 'escape',
          resolvedPath: path,
          range
        });
        return null;
      }
      references.push({
        sourcePath,
        elementIndex,
        attribute,
        value,
        kind: 'local',
        resolvedPath: path,
        range
      });
      return loadAsset(canonical, path, readKind, depth);
    };

    let deploymentContentSecurityPolicy: string | null = null;
    if (options.manifest?.deploymentHeaders !== undefined) {
      const headerCandidate = resolve(root, options.manifest.deploymentHeaders);
      if (!insideRoot(root, headerCandidate))
        throw new Error('Deployment-header evidence escapes input root');
      const canonical = await realpath(headerCandidate);
      if (!insideRoot(root, canonical))
        throw new Error('Deployment-header evidence symlink escapes input root');
      const path = normalizePath(relative(root, canonical));
      const loaded = await loadAsset(canonical, path, 'asset', 0);
      if (loaded !== null) {
        const text = decodeText(loaded.bytes, path);
        try {
          const value: unknown = JSON.parse(text);
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const record = value as Readonly<Record<string, unknown>>;
            const raw = record['content-security-policy'] ?? record['Content-Security-Policy'];
            deploymentContentSecurityPolicy = typeof raw === 'string' ? raw : null;
          }
        } catch {
          const match = /^content-security-policy\s*:\s*(.+)$/imu.exec(text);
          deploymentContentSecurityPolicy = match?.[1]?.trim() ?? null;
        }
      }
    }

    const pages: PageRecord[] = [];
    const normalizedEntries = [
      ...new Set(options.entries.map((entry) => entry.replaceAll('\\', '/')))
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const analyzedEntryPaths = new Set<string>();
    for (const entry of normalizedEntries) {
      const entryCandidate = isAbsolute(entry) ? entry : resolve(root, entry);
      if (!insideRoot(root, entryCandidate)) throw new Error(`Entry escapes input root: ${entry}`);
      const entryReal = await realpath(entryCandidate);
      if (!insideRoot(root, entryReal))
        throw new Error(`Entry symlink escapes input root: ${entry}`);
      const path = normalizePath(relative(root, entryReal));
      if (analyzedEntryPaths.has(path)) continue;
      analyzedEntryPaths.add(path);
      if (excluded(path, options.manifest?.generatedExclusions ?? [])) continue;
      const loadedEntry = await loadAsset(entryReal, path, 'html', 0);
      if (loadedEntry === null) continue;
      const source = decodeText(loadedEntry.bytes, path);
      const preflightNodes = preflightHtmlNodes(source, options.policy.limits.htmlNodesPerDocument);
      if (preflightNodes > options.policy.limits.htmlNodesPerDocument) {
        limits.push({
          id: 'htmlNodesPerDocument',
          limit: options.policy.limits.htmlNodesPerDocument,
          observed: preflightNodes,
          path
        });
        incompleteReasons.push(`HTML node preflight prevented parsing ${path}`);
        continue;
      }
      const fragmentContext = options.manifest?.fragments?.[path];
      if (
        options.manifest !== null &&
        fragmentContext === undefined &&
        options.manifest.pages[path] === undefined
      ) {
        throw new Error(`Manifest does not declare a page kind for ${path}`);
      }
      const html = parseHtml(path, source, fragmentContext);
      if (html.nodeCount > options.policy.limits.htmlNodesPerDocument) {
        limits.push({
          id: 'htmlNodesPerDocument',
          limit: options.policy.limits.htmlNodesPerDocument,
          observed: html.nodeCount,
          path
        });
        incompleteReasons.push(`HTML node limit was exceeded by ${path}`);
        continue;
      }
      const css: ParsedCss[] = [];
      const pageAssetPaths = new Set([path]);
      const parsedCssPaths = new Set<string>();
      let initialBytes = loadedEntry.record.bytes;
      let cssRuleCount = 0;
      const documentUrl = new URL(path, 'https://html5assay.invalid/');
      const baseElement = html.elements.find(
        (element) => element.tagName === 'base' && element.attributes.href !== undefined
      );
      let documentBase = documentUrl;
      if (baseElement?.attributes.href !== undefined) {
        try {
          documentBase = new URL(baseElement.attributes.href, documentUrl);
        } catch {
          /* invalid base href is handled as ordinary source evidence */
        }
      }
      const effectiveDocumentReference = (
        elementIndex: number | null,
        attributeName: string,
        raw: string
      ): string => {
        if (baseElement === undefined) return raw;
        if (baseElement?.index === elementIndex && attributeName === 'href') return raw;
        try {
          const effective = new URL(raw, documentBase);
          if (effective.origin !== documentUrl.origin) return effective.href;
          return `${decodeURIComponent(effective.pathname)}${effective.search}${effective.hash}`;
        } catch {
          return raw;
        }
      };

      const addPageAsset = (asset: AssetRecord): void => {
        if (!pageAssetPaths.has(asset.path)) {
          pageAssetPaths.add(asset.path);
          initialBytes += asset.bytes;
        }
      };

      const analyzeCss = async (
        cssPath: string,
        cssSource: string,
        referenceBasePath: string,
        depth: number,
        baseOffset = 0,
        hostSource = cssSource,
        documentScoped = false
      ): Promise<void> => {
        const cssIdentity = baseOffset === 0 ? cssPath : `${cssPath}#style-${baseOffset}`;
        if (parsedCssPaths.has(cssIdentity)) return;
        parsedCssPaths.add(cssIdentity);
        const estimated = preflightCssRules(
          cssSource,
          options.policy.limits.cssRulesPerGraph - cssRuleCount
        );
        if (cssRuleCount + estimated > options.policy.limits.cssRulesPerGraph) {
          limits.push({
            id: 'cssRulesPerGraph',
            limit: options.policy.limits.cssRulesPerGraph,
            observed: cssRuleCount + estimated,
            path: cssPath
          });
          incompleteReasons.push(`CSS rule preflight prevented parsing ${cssPath}`);
          return;
        }
        const parsed = parseCss(cssIdentity, cssSource, baseOffset, hostSource);
        cssRuleCount += parsed.rules.length;
        const resolveCssReference = async (
          cssReference: ParsedCss['urls'][number]
        ): Promise<void> => {
          const kind: AssetRecord['kind'] = cssReference.kind === 'import' ? 'css' : 'asset';
          const cssAttribute =
            cssReference.kind === 'import'
              ? '@import'
              : cssReference.kind === 'source-map'
                ? 'sourceMappingURL'
                : 'url()';
          const resolutionValue = documentScoped
            ? effectiveDocumentReference(null, cssAttribute, cssReference.value)
            : cssReference.value;
          const linked = await resolveReference(
            referenceBasePath,
            null,
            cssAttribute,
            cssReference.value,
            cssReference.range,
            depth + 1,
            kind,
            resolutionValue
          );
          if (linked !== null) {
            addPageAsset(linked.record);
            if (kind === 'css')
              await analyzeCss(
                linked.record.path,
                decodeText(linked.bytes, linked.record.path),
                linked.record.path,
                depth + 1
              );
          }
        };
        // Imported sheets participate before the importing sheet in cascade order.
        for (const cssReference of parsed.urls.filter((item) => item.kind === 'import')) {
          await resolveCssReference(cssReference);
        }
        css.push(parsed);
        for (const cssReference of parsed.urls.filter((item) => item.kind !== 'import')) {
          await resolveCssReference(cssReference);
        }
      };

      for (const element of html.elements) {
        const embedded = html.embeddedStyles.find((item) => item.elementIndex === element.index);
        if (embedded !== undefined)
          await analyzeCss(path, embedded.source, path, 0, embedded.baseOffset, source, true);
        const rel = (element.attributes.rel ?? '').toLowerCase().split(/\s+/u);
        if (element.attributes.href !== undefined) {
          const stylesheet = element.tagName === 'link' && rel.includes('stylesheet');
          const initialAsset =
            (element.tagName === 'link' &&
              rel.some((token) => ['icon', 'preload', 'modulepreload'].includes(token))) ||
            ['feimage', 'image', 'script', 'use'].includes(element.tagName.toLowerCase());
          const kind: AssetRecord['kind'] | null = stylesheet
            ? 'css'
            : initialAsset
              ? 'asset'
              : null;
          const linked = await resolveReference(
            path,
            element.index,
            'href',
            element.attributes.href,
            attrRange(html, element.index, 'href'),
            1,
            kind,
            effectiveDocumentReference(element.index, 'href', element.attributes.href)
          );
          if (linked !== null) {
            addPageAsset(linked.record);
            if (stylesheet)
              await analyzeCss(
                linked.record.path,
                decodeText(linked.bytes, linked.record.path),
                linked.record.path,
                1
              );
          }
        }
        if (
          ['feimage', 'image', 'script', 'use'].includes(element.tagName.toLowerCase()) &&
          element.attributes['xlink:href'] !== undefined
        ) {
          const value = element.attributes['xlink:href'];
          const linked = await resolveReference(
            path,
            element.index,
            'xlink:href',
            value,
            attrRange(html, element.index, 'xlink:href'),
            1,
            'asset',
            effectiveDocumentReference(element.index, 'xlink:href', value)
          );
          if (linked !== null) addPageAsset(linked.record);
        }
        for (const name of ['src', 'poster'] as const) {
          const value = element.attributes[name];
          if (value !== undefined) {
            const linked = await resolveReference(
              path,
              element.index,
              name,
              value,
              attrRange(html, element.index, name),
              1,
              'asset',
              effectiveDocumentReference(element.index, name, value)
            );
            if (linked !== null) addPageAsset(linked.record);
          }
        }
        if (element.tagName === 'form' && element.attributes.action !== undefined) {
          await resolveReference(
            path,
            element.index,
            'action',
            element.attributes.action,
            attrRange(html, element.index, 'action'),
            1,
            null,
            effectiveDocumentReference(element.index, 'action', element.attributes.action)
          );
        }
        if (
          ['button', 'input'].includes(element.tagName) &&
          element.attributes.formaction !== undefined
        ) {
          await resolveReference(
            path,
            element.index,
            'formaction',
            element.attributes.formaction,
            attrRange(html, element.index, 'formaction'),
            1,
            null,
            effectiveDocumentReference(element.index, 'formaction', element.attributes.formaction)
          );
        }
        if (element.tagName === 'object' && element.attributes.data !== undefined) {
          const linked = await resolveReference(
            path,
            element.index,
            'data',
            element.attributes.data,
            attrRange(html, element.index, 'data'),
            1,
            'asset',
            effectiveDocumentReference(element.index, 'data', element.attributes.data)
          );
          if (linked !== null) addPageAsset(linked.record);
        }
        for (const sourceSetName of ['srcset', 'imagesrcset'] as const) {
          const sourceSet = element.attributes[sourceSetName];
          if (sourceSet === undefined) continue;
          for (const item of sourceSet.split(',')) {
            const value = item.trim().split(/\s+/u)[0];
            if (value !== undefined && value !== '') {
              const linked = await resolveReference(
                path,
                element.index,
                sourceSetName,
                value,
                attrRange(html, element.index, sourceSetName),
                1,
                'asset',
                effectiveDocumentReference(element.index, sourceSetName, value)
              );
              if (linked !== null) addPageAsset(linked.record);
            }
          }
        }
        if (
          element.tagName === 'meta' &&
          (element.attributes['http-equiv'] ?? '').toLowerCase() === 'refresh'
        ) {
          const content = element.attributes.content ?? '';
          const refreshUrl = /(?:^|;)\s*url\s*=\s*["']?([^"']+)\s*["']?\s*$/iu.exec(content)?.[1];
          if (refreshUrl !== undefined)
            await resolveReference(
              path,
              element.index,
              'content',
              refreshUrl.trim(),
              attrRange(html, element.index, 'content'),
              1,
              null,
              effectiveDocumentReference(element.index, 'content', refreshUrl.trim())
            );
        }
        for (const name of ['attributionsrc', 'ping'] as const) {
          const raw = element.attributes[name];
          if (raw !== undefined) {
            for (const value of raw.split(/\s+/u).filter(Boolean)) {
              await resolveReference(
                path,
                element.index,
                name,
                value,
                attrRange(html, element.index, name),
                1,
                null,
                effectiveDocumentReference(element.index, name, value)
              );
            }
          }
        }
        const style = element.attributes.style;
        if (style !== undefined && style.trim() !== '') {
          const location = attrRange(html, element.index, 'style');
          const attributeSource = source.slice(location.start.offset, location.end.offset);
          const relativeValueOffset = attributeSource.indexOf(style);
          const valueOffset = location.start.offset + Math.max(0, relativeValueOffset);
          const prefix = `${element.tagName}:--h5a-element-${element.index}{`;
          await analyzeCss(
            path,
            `${prefix}${style}}`,
            path,
            0,
            valueOffset - prefix.length,
            source,
            true
          );
        }
      }
      pages.push({ path, kind: options.manifest?.pages[path] ?? null, html, css, initialBytes });
    }

    if (pages.length === 0) {
      if (limits.length === 0) limits.push({ id: 'analyzableEntries', limit: 1, observed: 0 });
      incompleteReasons.push(
        'No analyzable HTML entry remained after exclusions and safety limits'
      );
    }

    return {
      root,
      subjectDigest: hashSubject(assets),
      pages,
      assets,
      references,
      limits,
      incompleteReasons,
      deploymentContentSecurityPolicy
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /CSS|Unclosed|Unknown word|Missed semicolon/iu.test(message)
      ? 'H5A-PARSER-CSS'
      : /UTF-8/iu.test(message)
        ? 'H5A-DECODE-UTF8'
        : /escape/iu.test(message)
          ? 'H5A-PATH-BOUNDARY'
          : 'H5A-GRAPH-FAILURE';
    throw new GraphBuildFailure(code, hashSubject(assets));
  }
};
