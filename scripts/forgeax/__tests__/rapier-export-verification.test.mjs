import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('Rapier export verification accepts its real payload and refuses changed glue without rebuilding', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-rapier-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts/forgeax'), { recursive: true });
  await mkdir(resolve(root, 'packages/physics-rapier2d'), { recursive: true });
  await mkdir(resolve(root, 'scripts/lib'), { recursive: true });
  await cp(resolve('scripts/lib'), resolve(root, 'scripts/lib'), { recursive: true });
  for (const directory of ['scripts', 'patches'])
    await cp(
      resolve('packages/physics-rapier3d', directory),
      resolve(root, 'packages/physics-rapier3d', directory),
      { recursive: true },
    );
  await cp(
    resolve('packages/physics-rapier3d/package.json'),
    resolve(root, 'packages/physics-rapier3d/package.json'),
  );
  await symlink(
    resolve('packages/physics-rapier3d/node_modules'),
    resolve(root, 'packages/physics-rapier3d/node_modules'),
    'junction',
  );
  await cp(
    resolve('scripts/forgeax/build-rapier-native.mjs'),
    resolve(root, 'scripts/forgeax/build-rapier-native.mjs'),
  );
  await cp(resolve('package.json'), resolve(root, 'package.json'));
  await cp(
    resolve('packages/physics-rapier2d/package.json'),
    resolve(root, 'packages/physics-rapier2d/package.json'),
  );
  await cp(
    resolve('packages/physics-rapier2d/pkg'),
    resolve(root, 'packages/physics-rapier2d/pkg'),
    { recursive: true },
  );
  await symlink(resolve('node_modules'), resolve(root, 'node_modules'), 'junction');
  await symlink(
    resolve('packages/physics-rapier2d/node_modules'),
    resolve(root, 'packages/physics-rapier2d/node_modules'),
    'junction',
  );
  const invoke = () =>
    exec(process.execPath, ['scripts/forgeax/build-rapier-native.mjs', '2d', '--verify'], {
      cwd: root,
    });
  await invoke();
  const glue = resolve(root, 'packages/physics-rapier2d/pkg/rapier-native.mjs');
  const bad = `${await readFile(glue, 'utf8')}\n// changed payload\n`;
  await writeFile(glue, bad);
  await assert.rejects(invoke(), (error) => {
    assert.match(error.stderr, /Rapier WASM hash mismatch/);
    return true;
  });
  assert.equal(
    await readFile(glue, 'utf8'),
    bad,
    'verification must never rebuild rejected payload bytes',
  );
});
