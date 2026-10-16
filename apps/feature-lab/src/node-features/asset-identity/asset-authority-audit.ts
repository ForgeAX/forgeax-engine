import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineFeature } from '../../lab/feature';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../../../..');
const SCRIPT = resolve(REPO, 'scripts/forgeax/check-asset-authority-audit.mjs');

interface AuditFailure {
  readonly ok: false;
  readonly error: { readonly code: string };
}
interface AuditModule {
  readonly REQUIRED_CATEGORIES: readonly string[];
  loadAuthorityDefinition(root: string): Promise<{
    audit: { categories: Array<{ id: string; authority: { id: string } }>; schemaVersion: string };
  }>;
  auditAuthorityDefinition(
    definition: unknown,
    root: string,
  ): { readonly ok: true; readonly value: { categories: readonly unknown[] } } | AuditFailure;
}

function runCli(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, '--json'], { cwd: REPO }, (error, stdout, stderr) => {
      done({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout,
        stderr,
      });
    });
  });
}

export default defineFeature({
  title: 'Asset authority audit',
  catalog: 'Asset authority audit',
  kind: 'headless',
  summary:
    'schemas/asset-authority.schema.json plus its executable gate enumerate each category author, producer, and owner boundary.',
  expect:
    'The checked-in audit passes; dropping a category, a wrong schema version, or a duplicated authority is blocked with a code.',
  async run(checks) {
    const cli = await runCli();
    checks.equal('CLI gate exits 0 on the checked-in schema', cli.code, 0);
    await checks.run('CLI JSON lists every required category', () => {
      const parsed = JSON.parse(cli.stdout) as {
        schemaVersion: string;
        categories: Array<{ id: string }>;
      };
      return parsed.schemaVersion === 'asset-authority-audit/1' && parsed.categories.length >= 11
        ? true
        : cli.stdout.slice(0, 200);
    });

    const audit = (await import(pathToFileURL(SCRIPT).href)) as AuditModule;
    const definition = await audit.loadAuthorityDefinition(REPO);
    const clean = audit.auditAuthorityDefinition(definition, REPO);
    checks.ok('in-process audit is ok', clean.ok, clean.ok ? undefined : clean.error.code);
    checks.ok(
      'glb, fbx, image, font, audio, plugin are named categories',
      ['glb', 'fbx', 'image', 'font', 'audio', 'plugin'].every((id) =>
        audit.REQUIRED_CATEGORIES.includes(id),
      ),
    );

    const codeOf = (
      mutate: (value: typeof definition.audit) => typeof definition.audit,
    ): string => {
      const copy = structuredClone(definition);
      const result = audit.auditAuthorityDefinition({ ...copy, audit: mutate(copy.audit) }, REPO);
      return result.ok ? 'ok' : result.error.code;
    };
    checks.equal(
      'dropping a category is blocked',
      codeOf((value) => ({ ...value, categories: value.categories.slice(1) })),
      'category-set-incomplete',
    );
    checks.equal(
      'wrong schema version is blocked',
      codeOf((value) => ({ ...value, schemaVersion: 'asset-authority-audit/0' })),
      'audit-schema-version',
    );
    checks.equal(
      'duplicate authority id is blocked',
      codeOf((value) => {
        const [first, second] = value.categories;
        if (first !== undefined && second !== undefined) second.authority.id = first.authority.id;
        return value;
      }),
      'duplicate-authority',
    );
  },
});
