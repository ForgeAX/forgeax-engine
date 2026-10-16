import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { readReferencePng, writeReferencePng } from '../../../shared/png-codec.mjs';
const dir = resolve(process.argv[2]);
const verifyWriter = process.argv[3] === 'verify-writer';
const writer = verifyWriter || process.argv[3] === 'writer';
const modes = verifyWriter
  ? ['baseline']
  : writer
    ? ['baseline', 'shadow-position-invariant']
    : ['baseline', 'directional-shadow-one'];
const out = resolve(dir, writer ? 'writer-counterfactual' : 'receiver-counterfactual');
mkdirSync(out, { recursive: true });
const { create, globals } = createRequire(resolve(import.meta.dirname, '../../../../package.json'))(
  'webgpu',
);
Object.assign(globalThis, globals);
Object.defineProperty(globalThis.navigator, 'gpu', {
  configurable: true,
  value: create(['backend=metal']),
});
const difference = (a, b) => {
  let peak = 0,
    sum = 0,
    outside = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    peak = Math.max(peak, delta);
    sum += delta;
    if (delta > 2) outside++;
  }
  return {
    peakByteDifference: peak,
    meanByteDifference: sum / a.length,
    channelsOutsideTwoBytes: outside,
  };
};
const rows = [],
  pairs = new Map();
const depths = new Map();
for (const mode of modes)
  for (const encoding of ['weights', 'ids']) {
    const name = `forward-${encoding}-static-lod0-${'proof'}`;
    const bytes = readFileSync(resolve(dir, name + '.rhitape'));
    const tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    const live = readReferencePng(resolve(dir, name + '-capture.png'));
    const adapter = (await backend.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    let patches = 0;
    const factory = async (owner, desc) => {
      let code = desc.code;
      if (mode === 'shadow-position-invariant' && code.includes('fn shadowVertex')) {
        assert(code.includes('@builtin(position) clip:'));
        code = code.replace('@builtin(position) clip:', '@builtin(position) @invariant clip:');
        patches++;
      } else if (mode === 'directional-shadow-one') {
        const signature = /fn evalDirectionalShadowFactor[^\{]*\{/g;
        const match = signature.exec(code);
        if (match) {
          const start = match.index + match[0].length;
          let end = start,
            depth = 1;
          while (depth && end < code.length) {
            if (code[end] === '{') depth++;
            if (code[end] === '}') depth--;
            end++;
          }
          assert.equal(depth, 0);
          code = code.slice(0, start) + '\n return 1.0;\n' + code.slice(end - 1);
          patches++;
        }
      }
      return backend.createShaderModule(owner, { ...desc, code });
    };
    let replay;
    try {
      replay = (await openReplay(tape, { device, createShaderModule: factory })).unwrap();
      if (writer) {
        const lastByView = new Map();
        for (const work of model.works.filter((w) =>
          w.pipeline.shaders.some((s) => s.source?.includes('fn shadowVertex')),
        ))
          lastByView.set(work.attachments.depthStencilViewHandleId, work);
        assert.equal(lastByView.size, 4);
        const layers = [];
        for (const work of lastByView.values()) {
          const read = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap().attachment;
          assert.equal(read.format, 'depth32float');
          const bytes = Uint8Array.from(read.bytes);
          layers.push(new Float32Array(bytes.buffer));
          writeFileSync(resolve(out, `${mode}-${encoding}-cascade${layers.length - 1}.f32`), bytes);
        }
        depths.set(`${mode}-${encoding}`, layers);
      }
      const image = (await replay.inspectWork(model.works.at(-1).workIndex, ['pixels'])).unwrap()
        .attachment;
      assert(image?.bytes && image.width === 960 && image.height === 540);
      const pixels = image.bytes.slice();
      if (image.format.startsWith('bgra'))
        for (let i = 0; i < pixels.length; i += 4)
          [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
      const liveDifference = difference(pixels, live.pixels);
      if (mode === 'baseline')
        assert(
          liveDifference.peakByteDifference <= 2,
          'original tape replay must reproduce live output',
        );
      else assert(patches > 0, 'counterfactual must affect the actual receiver function');
      writeFileSync(resolve(out, `${mode}-${encoding}.png`), writeReferencePng(pixels, 960, 540));
      pairs.set(`${mode}-${encoding}`, pixels);
      rows.push({
        mode,
        encoding,
        originalTapeSha256: createHash('sha256').update(bytes).digest('hex'),
        workIndex: model.works.at(-1).workIndex,
        patches,
        liveDifference,
        selectedPixel: {
          x: 931,
          y: 415,
          rgba: Array.from(pixels.subarray((415 * 960 + 931) * 4, (415 * 960 + 932) * 4)),
        },
      });
    } finally {
      try {
        if (replay !== undefined) (await replay.dispose()).unwrap();
      } finally {
        device.nativeDevice().unwrap().destroy();
      }
    }
  }
const comparisons = modes.map((mode) => ({
  mode,
  ...difference(pairs.get(`${mode}-weights`), pairs.get(`${mode}-ids`)),
  ...(writer
    ? {
        depth: depths.get(`${mode}-weights`).map((a, layer) => {
          const b = depths.get(`${mode}-ids`)[layer];
          let changed = 0,
            peak = 0;
          for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d !== 0) changed++;
            peak = Math.max(peak, d);
          }
          return { layer, changedTexels: changed, maxAbsoluteDepthDifference: peak };
        }),
      }
    : {}),
}));
if (verifyWriter)
  for (const comparison of comparisons) {
    assert(comparison.peakByteDifference <= 2);
    assert(
      comparison.depth.every((d) => d.changedTexels === 0),
      'production material specializations must write identical cascade depth',
    );
  }
const report = {
  status: verifyWriter ? 'PASS' : 'DIAGNOSTIC',
  boundary: verifyWriter
    ? 'Unmodified production writer tapes replay on fresh devices; compare all four depth32float cascades and paired color.'
    : writer
      ? 'Original actual writer tapes, geometry, bindings and receiver stay unchanged. Only both shadow position outputs gain @invariant; depth and final color are independently compared.'
      : 'Original tapes, vertex geometry, all bindings and BRDF/Surface stay unchanged. Only the actual receiver directional shadow factor is replaced with one; this is cause attribution, not a product repair or quality pass.',
  rows,
  comparisons,
};
writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
