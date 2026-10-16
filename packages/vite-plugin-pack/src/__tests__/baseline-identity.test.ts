import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const auditSource = resolve(
  repositoryRoot,
  'packages/vite-plugin-pack/scripts/m0-branch-identity-audit.mjs',
);
const temporaryRepositories: string[] = [];
let identityAudit: AuditFixture | undefined;
type AuditFixture = {
  repository: { branch: string };
  baseIdentity: { ancestry: { ahead: number; baseIsAncestorOfHead: boolean } };
  distIdentity: { classification: string };
  designIdentity: { matchesExpected: boolean };
  protocolAnomalies: { records: Array<{ gapId: string }> };
  provenance: { status: string };
};

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function createIdentityFixture(): { repository: string; featureDirectory: string } {
  const repository = mkdtempSync(join(tmpdir(), 'forgeax-m0-identity-'));
  temporaryRepositories.push(repository);
  const scriptDirectory = join(repository, 'packages/vite-plugin-pack/scripts');
  const sourceDirectory = join(repository, 'packages/vite-plugin-pack/src');
  const featureDirectory = join(repository, '.forgeax-harness/forgeax-loop/fixture');
  const distDirectory = join(repository, 'packages/vite-plugin-pack/dist');
  mkdirSync(scriptDirectory, { recursive: true });
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(featureDirectory, { recursive: true });
  mkdirSync(distDirectory, { recursive: true });
  copyFileSync(auditSource, join(scriptDirectory, 'm0-branch-identity-audit.mjs'));
  writeFileSync(
    join(repository, 'packages/vite-plugin-pack/package.json'),
    '{"exports":{".":"./dist/index.js"}}\n',
  );
  writeFileSync(join(sourceDirectory, 'index.ts'), 'export const fixture = true;\n');
  writeFileSync(join(distDirectory, 'stale.js'), 'export const stale = true;\n');
  writeFileSync(
    join(distDirectory, '.forgeax-source-identity.json'),
    '{"sourceSha256":"0000000000000000000000000000000000000000000000000000000000000000"}\n',
  );
  const design = '# Fixture design\n\n  - ../reports/missing.md\n';
  writeFileSync(join(featureDirectory, 'design.md'), design);
  writeFileSync(
    join(featureDirectory, 'requirements.json'),
    JSON.stringify({
      designAuthority: {
        sha256: createHash('sha256').update(design).digest('hex'),
      },
    }),
  );
  writeFileSync(
    join(featureDirectory, 'research-ingest-log.jsonl'),
    [
      JSON.stringify({
        gapId: 'g2',
        status: 'failed',
        error: 'protocol fixture',
        resultPaths: ['g2.md'],
      }),
      JSON.stringify({
        gapId: 'g6',
        status: 'failed',
        error: 'protocol fixture',
        resultPaths: ['g6.md'],
      }),
    ].join('\n'),
  );
  git(repository, ['init', '-b', 'fixture-identity']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  git(repository, ['config', 'user.name', 'Fixture']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'fixture base']);
  const base = git(repository, ['rev-parse', 'HEAD']);
  writeFileSync(join(sourceDirectory, 'index.ts'), 'export const fixture = false;\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'fixture drift']);
  git(repository, ['update-ref', 'refs/remotes/origin/main', base]);
  return { repository, featureDirectory };
}

beforeAll(() => {
  const fixture = createIdentityFixture();
  const auditScript = join(
    fixture.repository,
    'packages/vite-plugin-pack/scripts/m0-branch-identity-audit.mjs',
  );
  const auditOutput = execFileSync(
    process.execPath,
    [auditScript, '--feature-dir', fixture.featureDirectory],
    { cwd: fixture.repository, encoding: 'utf8' },
  );
  identityAudit = JSON.parse(auditOutput) as AuditFixture;
});

afterAll(() => {
  for (const repository of temporaryRepositories.splice(0))
    rmSync(repository, { recursive: true, force: true });
});

function audit(): AuditFixture {
  if (!identityAudit) throw new Error('baseline identity fixture did not initialize');
  return identityAudit;
}

describe('M0 baseline identity fixtures', () => {
  it('preserves branch and base ancestry identity', () => {
    const result = audit();
    expect(result.repository.branch).toBe('fixture-identity');
    expect(result.baseIdentity.ancestry.ahead).toBe(1);
    expect(result.baseIdentity.ancestry.baseIsAncestorOfHead).toBe(true);
  });

  it('preserves stale dist and design identity evidence', () => {
    const result = audit();
    expect(result.distIdentity.classification).toBe('identity-mismatch');
    expect(result.designIdentity.matchesExpected).toBe(true);
    expect(result.distIdentity.classification).not.toBe('pass');
  });

  it('preserves protocol anomalies and unresolved provenance', () => {
    const result = audit();
    expect(result.protocolAnomalies.records.map((record) => record.gapId)).toEqual(['g2', 'g6']);
    expect(result.provenance.status).toBe('unresolved');
  });
});
