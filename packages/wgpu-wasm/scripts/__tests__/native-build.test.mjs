import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, cp, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNativeWgpu } from '../native-build.mjs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../..', import.meta.url));
async function fixture(t) {
  // A consumer installs only the public umbrella; transitive dependencies are
  // deliberately unavailable beside the generated output.
  const dir = await mkdtemp(join(tmpdir(), 'forgeax-wgpu-native-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'node_modules/@forgeax'), { recursive: true });
  await symlink(join(root, '../engine'), join(dir, 'node_modules/@forgeax/engine'), 'dir');
  const { directory } = await buildNativeWgpu({ out: join(dir, 'output') });
  const module = await import(pathToFileURL(join(directory, 'wgpu-native.mjs')));
  const bytes = new Uint8Array(await readFile(join(directory, 'wgpu.wasm')));
  return { dir, directory, module, bytes };
}

// The test exercises native admission and the actual compiled WASM. This object
// cannot draw and is deliberately not a GPU qualification fixture.
function nativeSurface() {
  const context = { VERSION: 7938, getParameter: () => 'WebGL 2.0 (contract test)' };
  return { canvas: { getContext: () => context }, context };
}

test('native binding instantiates the canonical WASM without browser globals and admits exact identities', async t => {
  const { module, bytes } = await fixture(t);
  const { canvas, context } = nativeSurface();
  let calls = 0;
  const host = {
    surfaces: [canvas], readWasm: async () => bytes,
    instantiate: async imports => {
      calls++;
      const bindings = imports['./wgpu_wasm_bg.js'];
      const canvasCheck = Object.entries(bindings).find(([key]) => key.startsWith('__wbg_instanceof_HtmlCanvasElement_'))[1];
      const contextCheck = Object.entries(bindings).find(([key]) => key.startsWith('__wbg_instanceof_WebGl2RenderingContext_'))[1];
      assert.equal(canvasCheck(canvas), true);
      assert.equal(canvasCheck({ ...canvas }), false);
      assert.equal(contextCheck(context), true);
      assert.equal(contextCheck({ ...context }), false);
      return WebAssembly.instantiate(bytes, imports);
    },
  };
  const first = module.initializeNativeWgpu(host);
  assert.equal(first, module.initializeNativeWgpu(host));
  await first;
  const parsed = module.parse('@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }');
  parsed.free();
  assert.equal(calls, 1);
  assert.equal(typeof globalThis.HTMLCanvasElement, 'undefined');
  await assert.rejects(module.initializeNativeWgpu({ ...host }), { operation: 'host-identity' });
});

test('corrupt native WASM is refused before instantiation and a corrected read can retry', async t => {
  const { module, bytes } = await fixture(t);
  const bad = bytes.slice(); bad[12] ^= 1;
  let current = bad;
  let calls = 0;
  const host = { surfaces: [nativeSurface().canvas], readWasm: async () => current,
    instantiate: imports => { calls++; return WebAssembly.instantiate(bytes, imports); } };
  await assert.rejects(module.initializeNativeWgpu(host), { operation: 'artifact-integrity' });
  assert.equal(calls, 0);
  current = bytes;
  await module.initializeNativeWgpu(host);
  assert.equal(calls, 1);
});

test('native ASTC profile admission declines an absent query and preserves available native behavior', async t => {
  const { module, bytes } = await fixture(t);
  const failure = new Error('native ASTC query failed');
  let query;
  const wasm = await module.initializeNativeWgpu({
    surfaces: [nativeSurface().canvas], readWasm: async () => bytes,
    instantiate: imports => {
      const queries = Object.entries(imports['./wgpu_wasm_bg.js'])
        .filter(([name]) => name.startsWith('__wbg_getSupportedProfiles_'));
      assert.equal(queries.length, 1);
      query = queries[0][1];
      return WebAssembly.instantiate(bytes, imports);
    },
  });
  for (const extension of [{}, { getSupportedProfiles: undefined }, { getSupportedProfiles: null }]) {
    Object.freeze(extension);
    const before = Object.getOwnPropertyDescriptors(extension);
    assert.equal(query(extension), 0);
    assert.deepEqual(Object.getOwnPropertyDescriptors(extension), before);
  }
  const profiles = ['ldr', 'hdr'];
  const extension = { getSupportedProfiles() { assert.equal(this, extension); return profiles; } };
  const index = query(extension);
  assert.equal(typeof index, 'number');
  assert.equal(wasm.__wbindgen_externrefs.get(index), profiles);
  wasm.__externref_table_dealloc(index);
  assert.equal(query({ getSupportedProfiles: () => undefined }), 0);
  assert.throws(() => query({ getSupportedProfiles() { throw failure; } }), error => error === failure);
});

test('a missing WebGL2 surface is refused before reading or instantiating WASM', async t => {
  const { module } = await fixture(t);
  await assert.rejects(module.initializeNativeWgpu({ surfaces: [{ getContext: () => null }],
    readWasm: () => assert.fail('must not read'), instantiate: () => assert.fail('must not instantiate'),
  }), { operation: 'surface-admission' });
});

test('producer refuses modified canonical glue and existing output', async t => {
  const { dir, directory } = await fixture(t);
  await assert.rejects(buildNativeWgpu({ out: directory }), { code: 'EEXIST' });
  const source = join(dir, 'canonical');
  await cp(join(root, 'pkg'), source, { recursive: true });
  await writeFile(join(source, 'wgpu_wasm.js'), '// not canonical');
  await assert.rejects(buildNativeWgpu({ out: join(dir, 'rejected'), pkgDirectory: source }), /glue bytes do not match/);
});

test('derived binding exposes checked native TypeScript exports without browser initialization', async t => {
  const { dir } = await fixture(t);
  const consumer = join(dir, 'consumer.mts');
  await writeFile(consumer, `
import { initializeNativeWgpu, parse, RhiWgpuInstance } from './output/wgpu-native.mjs';
import type { NativeWgpuHost } from '@forgeax/engine/wgpu-wasm/native-host';
declare const host: NativeWgpuHost;
await initializeNativeWgpu(host);
parse('shader').free();
await RhiWgpuInstance.create();
// @ts-expect-error Native binding has no browser/default initializer.
import browserInit from './output/wgpu-native.mjs';
// @ts-expect-error Canvas admission is a required host responsibility.
initializeNativeWgpu({ readWasm: host.readWasm, instantiate: host.instantiate });
`);
  execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'),
    '--ignoreConfig', '--noEmit', '--strict', '--module', 'nodenext', '--target', 'es2022',
    '--lib', 'es2022,dom,esnext.disposable', '--skipLibCheck', consumer], { stdio: 'pipe' });
});
