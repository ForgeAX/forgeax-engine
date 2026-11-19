import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import {
  compiledBasisHost,
  initBasisTranscoder,
  parseKtx2,
  transcodeKtx2,
} from '../../../dist/index.mjs';

assert(globalThis.gc, 'requires --expose-gc');
const factory = (await import('../../../pkg/encode/basis_encoder.mjs')).default;
const encoderModule = await factory({
  locateFile: () => new URL('../../../pkg/encode/basis_encoder.wasm', import.meta.url).href,
});
encoderModule.initializeBasis();
const encoder = new encoderModule.BasisEncoder();
encoder.setSliceSourceImage(0, new Uint8Array(16 * 16 * 4).fill(255), 16, 16, 0);
encoder.setCreateKTX2File(true);
encoder.setKTX2UASTCSupercompression(true);
encoder.setFormatMode(encoderModule.basis_tex_format.cUASTC_LDR_4x4.value);
encoder.setMipGen(false);
const output = new Uint8Array(1 << 20),
  length = encoder.encode(output);
encoder.delete();
assert(length > 0);
const parsed = await parseKtx2(output.slice(0, length));
assert(parsed.ok);

let instantiations = 0;
let host;
if (process.argv.includes('--host')) {
  const compiled = await WebAssembly.compile(
    await readFile(new URL('../../../pkg/basis_transcoder.wasm', import.meta.url)),
  );
  assert(compiled instanceof WebAssembly.Module);
  const recipe = compiledBasisHost(compiled);
  host = {
    ...recipe,
    instantiate(imports) {
      instantiations++;
      return recipe.instantiate(imports);
    },
  };
}
async function use(initialHost) {
  const pending = initBasisTranscoder(initialHost);
  assert.equal(initBasisTranscoder(), pending, 'concurrent callers share initialization');
  const module = await pending;
  const result = await transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
  assert(result.ok);
  assert.equal(result.value.mips[0].data.length, 256);
  return {
    weak: new WeakRef(module),
    weakMemory: new WeakRef(module.HEAP8.buffer),
    bytes: result.value.mips[0].data.slice(),
  };
}
const first = await use(host);
for (let i = 0; i < 8; i++) {
  await setImmediate();
  globalThis.gc();
}
assert.equal(first.weak.deref() === undefined, true, 'idle transcoder instance must collect');
assert.equal(
  first.weakMemory.deref() === undefined,
  true,
  'idle transcoder linear memory must collect',
);
const second = await use();
assert.deepEqual(second.bytes, first.bytes, 'reinstantiation preserves exact transcoded pixels');
if (host) assert.equal(instantiations, 2, 'later implicit init retains the original Host recipe');
