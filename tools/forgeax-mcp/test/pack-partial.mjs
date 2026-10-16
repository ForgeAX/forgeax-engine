import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'forgeax-codex-pack-partial-'));
const worker = resolve(import.meta.dirname, '../src/pack-inspect.mjs');
const cli = resolve(import.meta.dirname, '../../../packages/devkit/dist/cli.mjs');
const good = join(root, 'assets', 'scene.pack.json');
const bad = join(root, 'assets', 'broken.pack.json');
try {
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ id: 'pack-api-parity', name: 'Pack API parity', schemaVersion: '3.0.0', roots: {} }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pack-api-parity', type: 'module' }));
  await writeFile(join(root, 'main.ts'), 'export async function bootstrap() {}\n');
  await copyFile(resolve(import.meta.dirname, '../../../apps/hello/deep-agent-feedback/assets/scene.pack.json'), good);
  await writeFile(bad, '{ invalid JSON');
  const inspect = (sourcePath) => JSON.parse(execFileSync(process.execPath, [worker, root, sourcePath], { encoding: 'utf8' }));
  const inspectCli = (subject) => {
    const args = [cli, 'asset', 'inspect', '--root', root, '--subject', subject, '--json'];
    try { return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })); }
    catch (error) {
      assert.equal(error.status, 1);
      return JSON.parse(error.stdout);
    }
  };
  const healthy = inspect(good);
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
  assert.equal(healthy.value.sourcePath, good);
  assert.match(healthy.value.revision, /^sha256:/);
  assert.equal(healthy.value.packageId, '01900000-0000-7000-8000-000000000808');
  const broken = inspect(bad);
  assert.equal(broken.ok, false);
  const cliHealthy = inspectCli('assets/scene.pack.json');
  assert.equal(cliHealthy.ok, true, JSON.stringify(cliHealthy));
  for (const field of ['revision', 'packageId', 'format'])
    assert.equal(healthy.value[field], cliHealthy.value[field]);
  assert.deepEqual(healthy.value.assets.map(({ guid, kind, sourceKey }) => ({ guid, kind, sourceKey })),
    cliHealthy.value.assets.map(({ guid, kind, sourceKey }) => ({ guid, kind, sourceKey })));
  const cliBroken = inspectCli('assets/broken.pack.json');
  assert.equal(cliBroken.ok, false);
  assert.equal(broken.error.code, cliBroken.error.code);
  console.log(JSON.stringify({ healthy: healthy.value, broken: broken.error, cliParity: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
