import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeTape, buildFrameModel, openReplay, halfToFloat } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';

// Diagnostic replay only: replace the selected resolve output with its four
// rejection factors. The captured inputs and rejection calculations stay
// unchanged. This is not a rendered-result acceptance artifact.
const bytes = new Uint8Array(readFileSync(process.argv[2]));
const tape = decodeTape(bytes).unwrap();
const model = buildFrameModel(tape);
const works = model.works.filter(w => w.pipeline.shaders.some(s => s.entryPoint === 'ssr_temporal'));
assert.equal(works.length, 1);
const work = works[0];
const original = work.pipeline.shaders.find(s => s.entryPoint === 'ssr_temporal').source;
const store = /textureStore\(resolvedOutput,\s*(\w+),\s*\w+\);/g;
assert.equal([...original.matchAll(store)].length, 1);
const entry = original.slice(original.indexOf('fn ssr_temporal('));
const local = name => {
  const matches = [...entry.matchAll(new RegExp(`let (${name}(?:_\\d+)?) =`, 'g'))];
  assert.equal(matches.length, 1, `Expected one ${name} in the selected compiled entry`);
  return matches[0][1];
};
const normals = process.argv.includes('--normals');
const normalArguments = [...entry.matchAll(/normalReject\((\w+),\s*(\w+)\)/g)];
assert.equal(normalArguments.length, 1);
const [, currentNormal, previousNormal] = normalArguments[0];
const diagnostic = original.replace(store, (_, pixel) => normals
  ? `textureStore(resolvedOutput, ${pixel}, vec4<f32>(normalize(${previousNormal}), dot(normalize(${currentNormal}), normalize(${previousNormal}))));`
  : `textureStore(resolvedOutput, ${pixel}, vec4<f32>(
  select(0.0, 1.0, ${local('depthCompatible')}), select(0.0, 1.0, ${local('normalCompatible')}),
  ${local('temporal')}.w, select(0.0, 1.0, ${local('historyInBounds')})));`);
const backend = await bootstrapDawn('SSR rejection diagnostic replay', tape);
let patchedModules = 0;
const replay = (await openReplay(tape, {
  device: backend.freshDevice,
  createShaderModule: (device, descriptor) => {
    if (descriptor.code !== original) return backend.rhiWebgpu.createShaderModule(device, descriptor);
    patchedModules++;
    return backend.rhiWebgpu.createShaderModule(device, { ...descriptor, code: diagnostic });
  },
})).unwrap();
try {
  const id = work.bindings.find(b => b.groupIndex === 0 && b.binding === 7).resourceId;
  const output = (await replay.readResourceAtWork(id, work.workIndex)).unwrap();
  assert.ok(patchedModules > 0, 'The selected shader must actually be replaced');
  assert.equal(output.format, 'rgba16float');
  const data = new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength);
  const normalId = work.bindings.find(b => b.groupIndex === 0 && b.binding === 2).resourceId;
  const normalTexture = normals ? (await replay.readResourceAtWork(normalId, work.workIndex)).unwrap() : undefined;
  if (normalTexture) assert.ok(['rgba8unorm', 'rgba16float'].includes(normalTexture.format), normalTexture.format);
  const pixels = process.argv.slice(3).filter(value => value !== '--normals').map(pair => {
    const [x, y] = pair.split(',').map(Number);
    assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < output.width && y < output.height);
    const offset = (y * output.width + x) * 8;
    const factors = Array.from({ length: 4 }, (_, i) => halfToFloat(data.getUint16(offset + i * 2, true)));
    const current = normalTexture === undefined ? undefined : Array.from({ length: 3 }, (_, c) => {
      const offset = ((y * 2) * normalTexture.width + x * 2) * 4 + c;
      const encoded = normalTexture.format === 'rgba8unorm' ? normalTexture.bytes[offset] / 255
        : halfToFloat(new DataView(normalTexture.bytes.buffer, normalTexture.bytes.byteOffset).getUint16(offset * 2, true));
      return encoded * 2 - 1;
    });
    return normals ? { x, y, currentNormal: current, reconstructedPreviousNormal: factors.slice(0, 3), normalAgreement: factors[3] }
      : { x, y, depthCompatible: factors[0], normalCompatible: factors[1], reactive: factors[2], historyInBounds: factors[3] };
  });
  console.log(JSON.stringify({ mode: normals ? 'counterfactual-ssr-normal-diagnostic' : 'counterfactual-ssr-rejection-diagnostic',
    digest: createHash('sha256').update(bytes).digest('hex'), workIndex: work.workIndex,
    originalShaderDigest: createHash('sha256').update(original).digest('hex'), pixels }, null, 2));
} finally { replay.dispose(); }
process.exit(0);
