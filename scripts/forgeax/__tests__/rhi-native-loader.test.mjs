import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildNativeWgpu } from '../../../packages/wgpu-wasm/scripts/native-build.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);

test('RHI native loader requires Host admission and adopts the actual namespace through ordinary ensureReady', async (t) => {
  const directory = await mkdtemp(join(root, 'packages/wgpu-wasm/.native-loader-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  await buildNativeWgpu({ out: output });
  const fixture = fileURLToPath(new URL('./fixtures/rhi-native-loader.mjs', import.meta.url));
  for (const native of [false, true]) {
    const { stdout } = await execute(
      process.execPath,
      [...(native ? ['--conditions=forgeax-native'] : []), fixture, ...(native ? [output] : [])],
      { cwd: root, timeout: 30_000 },
    );
    assert.deepEqual(JSON.parse(stdout.trim()), { parsed: true, instantiations: native ? 1 : 0 });
  }
});

test('RHI native bundle excludes the complete browser wgpu loader and WASM discovery path', async () => {
  const require = createRequire(resolve(root, 'package.json'));
  const { build } = createRequire(require.resolve('tsup'))('esbuild');
  const options = {
    entryPoints: [resolve(root, 'packages/rhi-wgpu/dist/index.mjs')],
    bundle: true,
    platform: 'neutral',
    mainFields: ['module', 'main'],
    format: 'esm',
    write: false,
    metafile: true,
  };
  const native = await build({ ...options, conditions: ['forgeax-native'] });
  const inputs = Object.keys(native.metafile.inputs);
  assert.ok(inputs.some((path) => path.endsWith('/dist/wasm-native.mjs')));
  assert.ok(
    !inputs.some((path) => path.includes('/wgpu-wasm/') || path.endsWith('/wasm-browser.mjs')),
  );
  assert.doesNotMatch(native.outputFiles[0].text, /wgpu_wasm_bg\.wasm|wgpu_wasm\.js/);
  const browser = await build(options);
  assert.ok(
    Object.keys(browser.metafile.inputs).some((path) => path.endsWith('/wgpu-wasm/dist/index.mjs')),
  );
});
