import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { artifact, filesUnder, stageSdkCarrier, writePackageArchive } from '../sdk-lib.mjs';

const execute = promisify(execFile);

test('the npm SDK omits Engine-owned bytes and retains verified references for editable source', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-carrier-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = resolve(root, 'sdk');
  const sourceFiles = {
    'source/engine/.forgeax-public-distribution': 'public SDK\n',
    'source/engine/packages/math/src/index.ts': 'export const value = 1;\n',
    'source/engine/packages/math/dist/index.mjs': 'export const value = 1;\n',
    'source/engine/packages/ecs/dist/index.mjs': 'export const unchanged = true;\n',
    'source/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': '\0asm',
  };
  const entries = {
    ...sourceFiles,
    'bin/forgeax.mjs': 'export {};\n',
    'templates/empty/forge.json': '{}\n',
    'tools/view/package.json': JSON.stringify({
      name: '@forgeax/view',
      private: true,
      version: '1.2.3',
    }),
    'tools/view/host.pack.json': '{"name":"SDK View"}\n',
    'tools/view/dist/index.mjs': 'export const embeddedView = true;\n',
    'packages/math/dist/index.mjs': 'export const value = 1;\n',
    'store/pnpm/content': 'offline cache\n',
    'toolchain/wasm/pkg.wasm': '\0asm',
  };
  for (const [path, bytes] of Object.entries(entries)) {
    await mkdir(dirname(resolve(sdk, path)), { recursive: true });
    await writeFile(resolve(sdk, path), bytes);
  }
  const artifacts = await Promise.all((await filesUnder(sdk)).map((path) => artifact(sdk, path)));
  const sourceArtifacts = artifacts.filter(({ path }) => path.startsWith('source/engine/'));
  const source = {
    root: 'source/engine',
    fileCount: sourceArtifacts.length,
    byteCount: sourceArtifacts.reduce((sum, row) => sum + row.bytes, 0),
  };
  await writeFile(
    resolve(sdk, 'sdk-manifest.json'),
    JSON.stringify({ sdkVersion: '1.2.3', source, artifacts }),
  );
  const packageRoot = resolve(root, 'package');
  await mkdir(packageRoot);
  await writeFile(
    resolve(packageRoot, 'package.json'),
    JSON.stringify({ name: '@forgeax/engine-sdk', version: '1.2.3' }),
  );
  const engine = resolve(root, 'engine/package');
  const engineFiles = {
    'package.json': JSON.stringify({ name: '@forgeax/engine', version: '1.2.3' }),
    'node_modules/@forgeax/engine-math/dist/index.mjs':
      sourceFiles['source/engine/packages/math/dist/index.mjs'],
    'node_modules/@forgeax/engine-ecs/dist/index.mjs':
      sourceFiles['source/engine/packages/ecs/dist/index.mjs'],
    'node_modules/@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm_bg.wasm':
      sourceFiles['source/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm'],
  };
  for (const [path, bytes] of Object.entries(engineFiles)) {
    await mkdir(dirname(resolve(engine, path)), { recursive: true });
    await writeFile(resolve(engine, path), bytes);
  }
  const engineArchive = resolve(root, 'engine.tgz');
  await writePackageArchive(resolve(root, 'engine'), engineArchive);
  await stageSdkCarrier(sdk, resolve(packageRoot, 'sdk'), engineArchive);
  const archive = resolve(root, 'sdk.tgz');
  await writePackageArchive(root, archive);
  const unpack = resolve(root, 'unpack');
  await mkdir(unpack);
  await execute('tar', ['-xzf', archive, '-C', unpack]);
  const installed = resolve(unpack, 'package/sdk');
  const manifest = JSON.parse(await readFile(resolve(installed, 'sdk-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.source, source);
  const reused = manifest.artifacts.filter((entry) => entry.enginePath !== undefined);
  assert.equal(reused.length, 4);
  for (const { enginePath, ...expected } of manifest.artifacts) {
    if (enginePath !== undefined) {
      await assert.rejects(readFile(resolve(installed, expected.path)), { code: 'ENOENT' });
      const actual = await artifact(engine, resolve(engine, enginePath));
      assert.equal(actual.bytes, expected.bytes);
      assert.equal(actual.sha256, expected.sha256);
    } else assert.deepEqual(await artifact(installed, resolve(installed, expected.path)), expected);
  }
  assert.deepEqual(
    manifest.artifacts
      .filter(({ path }) => path.startsWith('source/engine/'))
      .map(({ enginePath, ...entry }) => entry),
    sourceArtifacts,
  );
  for (const [path, bytes] of Object.entries(sourceFiles)) {
    assert.equal(await readFile(resolve(sdk, path), 'utf8'), bytes);
  }
  for (const path of ['packages', 'store', 'toolchain/wasm']) {
    await assert.rejects(readFile(resolve(installed, path)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(resolve(sdk, 'store/pnpm/content'), 'utf8'), 'offline cache\n');
});
