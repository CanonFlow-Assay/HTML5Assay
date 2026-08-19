import { createHash } from 'node:crypto';
import type { Digest } from '../api/model.js';

const compareUnicode = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const normalizeForCanonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => compareUnicode(left, right))
        .map(([key, item]) => [key, normalizeForCanonicalJson(item)])
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(normalizeForCanonicalJson(value), null, 2)}\n`;

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export const digest = (value: string | Uint8Array): Digest => ({
  algorithm: 'sha-256',
  value: sha256(value)
});

export const canonicalDigest = (value: unknown): Digest => digest(canonicalJson(value));

export { compareUnicode };
