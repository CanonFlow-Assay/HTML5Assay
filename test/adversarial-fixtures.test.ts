import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { analyze, type PolicyPack, type RunVerdict } from '../src/api/index.js';

interface Fixture {
  readonly schemaVersion: 'html5assay.adversarial-fixture.v1';
  readonly id: string;
  readonly entries: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly policy: {
    readonly base: 'cff-web-strict' | 'cff-web-balanced';
    readonly limits?: Partial<PolicyPack['limits']>;
  };
  readonly expected: {
    readonly verdict: RunVerdict;
    readonly findingRuleIds?: readonly string[];
    readonly limitIds?: readonly string[];
    readonly toolFailureCodes?: readonly string[];
  };
}

const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

void test('all data-only adversarial fixtures validate and produce their declared evidence', async () => {
  const schema = await json<AnySchema>('schemas/adversarial-fixture.schema.json');
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const minimal = {
    schemaVersion: 'html5assay.adversarial-fixture.v1',
    id: 'unsafe-name',
    description: 'Boundary probe',
    entries: ['index.html'],
    policy: { base: 'cff-web-strict' },
    expected: { verdict: 'ToolFailure' }
  };
  for (const path of ['../outside', '..\\outside', 'C:\\outside', 'C:/outside', '/outside']) {
    assert.equal(
      validate({ ...minimal, files: { [path]: 'x' } }),
      false,
      `fixture path should be rejected: ${path}`
    );
  }
  const names = (await readdir('fixtures')).filter((name) => name.endsWith('.fixture.json')).sort();
  assert.ok(names.length >= 4);
  for (const name of names) {
    const fixture = await json<Fixture>(join('fixtures', name));
    assert.equal(validate(fixture), true, `${name}: ${JSON.stringify(validate.errors)}`);
    const root = await mkdtemp(join(tmpdir(), 'html5assay-adversarial-'));
    try {
      for (const [path, source] of Object.entries(fixture.files)) {
        const target = resolve(root, path);
        const fromRoot = relative(root, target);
        assert.ok(fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, source);
      }
      let policy: { id: string; path?: string } = { id: fixture.policy.base };
      if (fixture.policy.limits !== undefined) {
        const base = await json<PolicyPack>(`policies/${fixture.policy.base}-1.0.0.json`);
        const custom = {
          ...base,
          id: `fixture-${fixture.id}`,
          limits: { ...base.limits, ...fixture.policy.limits }
        };
        await writeFile(join(root, 'policy.json'), JSON.stringify(custom));
        policy = { id: custom.id, path: 'policy.json' };
      }
      const result = await analyze({ root, entries: fixture.entries, policy });
      assert.equal(result.verdict, fixture.expected.verdict, fixture.id);
      for (const id of fixture.expected.findingRuleIds ?? [])
        assert.ok(
          result.findings.some((finding) => finding.ruleId === id),
          `${fixture.id}: missing ${id}`
        );
      for (const id of fixture.expected.limitIds ?? [])
        assert.ok(
          result.limits.some((limit) => limit.id === id),
          `${fixture.id}: missing ${id}`
        );
      for (const code of fixture.expected.toolFailureCodes ?? [])
        assert.ok(
          result.toolFailures.some((failure) => failure.code === code),
          `${fixture.id}: missing ${code}`
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
