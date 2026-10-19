import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const nativeDirectory = process.argv[2];
const saved = globalThis.WebAssembly;
if (nativeDirectory) globalThis.WebAssembly = undefined;
try {
  const { ensureReady, requestAdapter } = await import(
    new URL('../../../../packages/rhi-wgpu/dist/index.mjs', import.meta.url)
  );
  let module;
  let instantiations = 0;
  if (nativeDirectory) {
    const missing = await requestAdapter();
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'rhi-not-available');
    await assert.rejects(ensureReady(), { code: 'rhi-not-available' });
    const failure = new Error('native host unavailable');
    await assert.rejects(
      ensureReady({
        initFn: async () => {
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    const binding = await import(pathToFileURL(`${nativeDirectory}/wgpu-native.mjs`));
    const bytes = await readFile(`${nativeDirectory}/wgpu.wasm`);
    // Admission-only native object: this test does not claim a rendered frame.
    const context = { VERSION: 7938, getParameter: () => 'WebGL 2.0 (loader contract)' };
    const host = {
      surfaces: [{ getContext: () => context }],
      readWasm: async () => bytes,
      instantiate: async (imports) => {
        instantiations += 1;
        return saved.instantiate(bytes, imports);
      },
    };
    const initFn = async () => {
      await binding.initializeNativeWgpu(host);
      return binding;
    };
    const first = ensureReady({ initFn });
    assert.equal(ensureReady({ initFn }), first);
    module = await first;
    assert.equal(module, binding);
    assert.equal(await ensureReady(), binding);
    assert.equal(instantiations, 1);
    assert.equal(globalThis.WebAssembly, undefined);
  } else {
    module = await ensureReady();
  }
  const shader = module.parse(
    '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
  );
  shader.free();
  process.stdout.write(`${JSON.stringify({ parsed: true, instantiations })}\n`);
} finally {
  globalThis.WebAssembly = saved;
}
