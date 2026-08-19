import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { digestEvidence } from './evidence.mjs';
import { browserMatrixIssues } from './matrix.mjs';

const input = process.argv[2];
if (input === undefined) throw new Error('Usage: verify-evidence.mjs <browser-evidence.json>');
const evidence = JSON.parse(await readFile(resolve(input), 'utf8'));
const matrixIssues = browserMatrixIssues(evidence.results);
if (matrixIssues.length > 0)
  throw new Error(`Browser evidence matrix validation failed: ${matrixIssues.join('; ')}`);
const schema = JSON.parse(
  await readFile(new URL('../schemas/browser-evidence.schema.json', import.meta.url), 'utf8')
);
const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  formats: { 'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u }
});
const validate = ajv.compile(schema);
if (!validate(evidence))
  throw new Error(`Browser evidence schema validation failed: ${JSON.stringify(validate.errors)}`);
const { evidenceDigest, ...payload } = evidence;
const expected = digestEvidence(payload);

if (evidenceDigest?.algorithm !== expected.algorithm || evidenceDigest?.value !== expected.value)
  throw new Error('Browser evidence digest does not bind the canonical evidence payload');
if (!/^[0-9a-f]{40}$/u.test(evidence.candidate?.gitCommit ?? ''))
  throw new Error('Browser evidence does not bind a full Git commit');
if (!/^[0-9a-f]{64}$/u.test(evidence.candidate?.archiveSha256 ?? ''))
  throw new Error('Browser evidence does not bind a candidate archive SHA-256');
if (evidence.result === 'Pass' && evidence.failures.length !== 0)
  throw new Error('Passing browser evidence contains failures');
if (evidence.result === 'Fail' && evidence.failures.length === 0)
  throw new Error('Failing browser evidence does not identify a failure');

process.stdout.write(`browser evidence digest verified: ${expected.value}\n`);
