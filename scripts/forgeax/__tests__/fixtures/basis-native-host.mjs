import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const native = process.argv[2] === 'native';
const owner = new URL('../../../../packages/codec/', import.meta.url);
const wasmBytes = await readFile(new URL('pkg/basis_transcoder.wasm', owner));
// Fixture production remains build-time work, before entering the restricted Host.
const encoderFactory = (await import(new URL('pkg/encode/basis_encoder.mjs', owner))).default;
const encoderModule = await encoderFactory({
  locateFile: () => new URL('pkg/encode/basis_encoder.wasm', owner).href,
  print() {},
});
encoderModule.initializeBasis();
const encoder = new encoderModule.BasisEncoder();
const pixels = new Uint8Array(16 * 16 * 4);
for (let i = 0; i < pixels.length; i += 4) pixels.set([32, 128, 224, 255], i);
encoder.setSliceSourceImage(0, pixels, 16, 16, 0);
encoder.setCreateKTX2File(true);
encoder.setKTX2UASTCSupercompression(true);
encoder.setFormatMode(encoderModule.basis_tex_format.cUASTC_LDR_4x4.value);
encoder.setPerceptual(true);
encoder.setMipGen(true);
encoder.controlThreading(false, 0);
const encoded = new Uint8Array(1 << 20);
const size = encoder.encode(encoded);
encoder.delete();
assert.ok(size > 0);

const saved = {
  WebAssembly: globalThis.WebAssembly,
  Function: globalThis.Function,
  process: globalThis.process,
  fetch: globalThis.fetch,
};
let instantiations = 0;
let result;
try {
  if (native) {
    globalThis.WebAssembly = undefined;
    globalThis.process = undefined;
    globalThis.Function = () => {
      throw new Error('dynamic code is unavailable');
    };
    globalThis.fetch = () => {
      throw new Error('browser fetch is unavailable');
    };
  }
  const codec = await import(new URL('dist/index.mjs', owner));
  if (native) {
    await assert.rejects(
      codec.initBasisTranscoder(),
      (error) =>
        error.message === 'codec-init-failed' && /explicit WASM Host/.test(error.cause.message),
    );
    await assert.rejects(
      codec.initBasisTranscoder({
        readWasm: async () => wasmBytes,
        instantiate: async () => {
          throw new Error('native path unavailable');
        },
      }),
      (error) =>
        error.message === 'codec-init-failed' && error.cause.message === 'native path unavailable',
    );
    await assert.rejects(
      codec.initBasisTranscoder({
        readWasm: async () => wasmBytes,
        instantiate: async () => ({ instance: { exports: {} } }),
      }),
      /codec-init-failed/,
    );
    const corrupt = new Uint8Array(wasmBytes);
    corrupt[corrupt.length - 1] ^= 1;
    for (const invalid of [corrupt, wasmBytes.subarray(1)]) {
      await assert.rejects(
        codec.initBasisTranscoder({
          readWasm: async () => invalid,
          instantiate: async () => assert.fail('mismatched WASM must not instantiate'),
        }),
        (error) => error.message === 'codec-init-failed' && /differs/.test(error.cause.message),
      );
    }
    const host = {
      readWasm: async () => wasmBytes,
      instantiate: async (imports) => {
        instantiations += 1;
        assert.ok(
          Object.values(imports).some((namespace) => Object.keys(namespace).length > 10),
          'the generated Emscripten imports must reach the Host intact',
        );
        return saved.WebAssembly.instantiate(wasmBytes, imports);
      },
    };
    const first = codec.initBasisTranscoder(host);
    assert.equal(codec.initBasisTranscoder(host), first);
    const module = await first;
    assert.equal(await codec.initBasisTranscoder(), module);
    assert.equal(typeof module.KTX2File, 'function', 'Embind registration must finish');
    assert.equal(instantiations, 1);
  }
  const parsed = await codec.parseKtx2(encoded.slice(0, size));
  assert.ok(parsed.ok);
  const transcoded = await codec.transcodeKtx2(parsed.value, 'rgba8unorm');
  assert.ok(transcoded.ok, JSON.stringify(transcoded));
  assert.equal(transcoded.value.width, 16);
  assert.equal(transcoded.value.height, 16);
  assert.equal(transcoded.value.mips.length, 5);
  const firstPixel = transcoded.value.mips[0].data.slice(0, 4);
  for (let channel = 0; channel < 4; channel += 1) {
    assert.ok(
      Math.abs(firstPixel[channel] - pixels[channel]) <= 3,
      `real decoded pixel differs at channel ${channel}: ${firstPixel}`,
    );
  }
  const repeated = await codec.transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
  assert.ok(repeated.ok);
  assert.equal(repeated.value.mips[0].data.length, 256);
  if (native) {
    assert.equal(instantiations, 1, 'ordinary transcodes retain the initialized module');
    assert.equal(globalThis.WebAssembly, undefined);
  }
  result = {
    levels: transcoded.value.mips.length,
    rgba: transcoded.value.mips.map((mip) => createHash('sha256').update(mip.data).digest('hex')),
    bc7: repeated.value.mips.map((mip) => createHash('sha256').update(mip.data).digest('hex')),
  };
} finally {
  Object.assign(globalThis, saved);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
