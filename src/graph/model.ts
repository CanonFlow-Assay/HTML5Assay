import type { Digest, PageKind, ResourceLimit, SourceRange } from '../api/model.js';
import type { ParsedCss, ParsedHtml } from '../parse/types.js';

export interface AssetRecord {
  readonly path: string;
  readonly bytes: number;
  readonly digest: Digest;
  readonly kind: 'html' | 'css' | 'asset';
  readonly depth: number;
}

export interface ReferenceEvidence {
  readonly sourcePath: string;
  readonly elementIndex: number | null;
  readonly attribute: string;
  readonly value: string;
  readonly kind: 'local' | 'remote' | 'embedded' | 'invalid' | 'escape' | 'missing';
  readonly resolvedPath: string | null;
  readonly range: SourceRange;
}

export interface PageRecord {
  readonly path: string;
  readonly kind: PageKind | null;
  readonly html: ParsedHtml;
  readonly css: readonly ParsedCss[];
  readonly initialBytes: number;
}

export interface DocumentGraph {
  readonly root: string;
  readonly subjectDigest: Digest;
  readonly pages: readonly PageRecord[];
  readonly assets: readonly AssetRecord[];
  readonly references: readonly ReferenceEvidence[];
  readonly limits: readonly ResourceLimit[];
  readonly incompleteReasons: readonly string[];
  readonly deploymentContentSecurityPolicy: string | null;
}
