import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { releaseEvidenceConsistencyIssues } from './consistency.mjs';

const input = process.argv[2];
if (input === undefined) throw new Error('Usage: verify.mjs <release-evidence.json>');
const record = JSON.parse(await readFile(resolve(input), 'utf8'));
const schema = JSON.parse(
  await readFile(new URL('../schemas/release-evidence.schema.json', import.meta.url), 'utf8')
);
const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  formats: { 'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u }
});
const validate = ajv.compile(schema);
if (!validate(record))
  throw new Error(`Release evidence schema validation failed: ${JSON.stringify(validate.errors)}`);
const issues = releaseEvidenceConsistencyIssues(record);
if (issues.length > 0)
  throw new Error(`Release evidence consistency validation failed: ${issues.join('; ')}`);

process.stdout.write(`release evidence consistent: ${resolve(input)}\n`);
