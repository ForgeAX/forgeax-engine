import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { prepareAssetsCheckout } from '../prepare-assets-checkout.mjs';
import { preparePnpmWorkspace } from '../prepare-pnpm-workspace.mjs';
import { prepareSourceCheckout } from '../prepare-source-checkout.mjs';

const exec = promisify(execFile);
test('source preparation retains ordinary exported directories without a Git repository', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-expanded-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, '.forgeax-standalone-repository'), 'standalone\n');
  for (const [path, entry] of [
    ['tools/view', 'package.json'],
    ['third_party/wgpu', 'Cargo.toml'],
    ['third_party/blitz', 'Cargo.toml'],
    ['forgeax-engine-assets', 'README.md'],
  ]) {
    await mkdir(resolve(root, path), { recursive: true });
    await writeFile(resolve(root, path, entry), 'pinned source\n');
  }
  assert.deepEqual(preparePnpmWorkspace(root), { path: 'tools/view', status: 'expanded' });
  assert.deepEqual(prepareAssetsCheckout(root), {
    path: 'forgeax-engine-assets',
    status: 'expanded',
  });
  for (const path of ['third_party/wgpu', 'third_party/blitz'])
    assert.deepEqual(prepareSourceCheckout(root, path), { path, status: 'expanded' });
  const result = await exec(process.execPath, [resolve('scripts/ci/prepare-view-checkout.mjs')], {
    cwd: root,
  });
  assert.match(result.stdout, /expanded source already present/);
  assert.equal(await readFile(resolve(root, 'tools/view/package.json'), 'utf8'), 'pinned source\n');
  await rm(resolve(root, 'tools/view/package.json'));
  assert.throws(() => preparePnpmWorkspace(root), /expanded-source-missing/);
});
