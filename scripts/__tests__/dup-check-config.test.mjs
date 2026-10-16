import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const source = Array.from(
  { length: 45 },
  (_, index) => `export function value${index}(input) { return input + ${index}; }`,
).join('\n');

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-dup-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['packages', 'apps', 'scripts', 'templates']) {
    await mkdir(join(root, directory));
  }
  const config = JSON.parse(await readFile(join(repository, 'config/jscpd.json'), 'utf8'));
  config.filePairIgnore = [];
  const inputs = {
    'config/jscpd.json': JSON.stringify(config),
    'scripts/dup-check.mjs': await readFile(join(repository, 'scripts/dup-check.mjs'), 'utf8'),
    ...files,
  };
  for (const [name, contents] of Object.entries(inputs)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction');
  return root;
}

test('nested duplication config still scans repository source paths', async (t) => {
  const root = await fixture(t, {
    'packages/sample/first.ts': source,
    'packages/sample/second.ts': source,
  });
  const result = spawnSync(process.execPath, ['scripts/dup-check.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /packages\/sample\/first\.ts/);
  assert.match(result.stdout, /packages\/sample\/second\.ts/);
});

test('nested duplication config excludes WASM payloads and archived evidence', async (t) => {
  const root = await fixture(t, {
    'packages/sample/current.ts': source,
    'packages/wgpu-wasm/pkg/generated.ts': source,
    'scripts/dev-verify/wave1-rendering/evidence/previous-run/historical.ts': source,
  });
  const result = spawnSync(process.execPath, ['scripts/dup-check.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(await readFile(join(root, 'report/jscpd-report.json'), 'utf8'));
  assert.equal(report.duplicates.length, 0);
});
