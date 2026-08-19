import { createHash } from 'node:crypto';

const ordered = (value) => {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, ordered(item)])
    );
  return value;
};

export const canonicalEvidenceJson = (value) => JSON.stringify(ordered(value));

export const digestEvidence = (value) => ({
  algorithm: 'sha-256',
  value: createHash('sha256').update(canonicalEvidenceJson(value)).digest('hex')
});
