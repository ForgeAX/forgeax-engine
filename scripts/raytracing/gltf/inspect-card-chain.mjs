import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CARD_LOOKUP_STRIDE,
  CARD_LOOKUP_WGSL,
} from '../../../packages/render/src/raytracing/card-lookup.ts';
import {
  buildFrameModel,
  decodeTape,
  halfToFloat,
} from '../../../packages/rhi-debug/dist/index.mjs';
import { inspectCardSupport } from './card-support.mjs';

assert.equal(process.argv.length, 3, 'usage: bun inspect-card-chain.mjs <check-cards-output>');
const directory = resolve(process.argv[2]);
const read = async (name) => new Uint8Array(await readFile(resolve(directory, name)));
const hash = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const capture = JSON.parse(await readFile(resolve(directory, 'capture.json'), 'utf8'));
const replay = JSON.parse(await readFile(resolve(directory, 'replay.json'), 'utf8'));
const bytes = await read('cards.rhitape');
assert.equal(hash(bytes), capture.tapeDigest);
assert.equal(replay.tapeDigest, capture.tapeDigest);
assert.deepEqual(replay.errors, []);
assert.deepEqual(replay.gpuErrors, []);
const tape = decodeTape(bytes).unwrap(),
  model = buildFrameModel(tape);
assert.deepEqual(model.unseededResources, []);
assert.deepEqual(capture.gpuErrors, []);
const planeNames = ['albedoRoughness', 'normals', 'emissionMetallic', 'f0Validity', 'depth'];
const planeBytes = await Promise.all(planeNames.map((name) => read(`${name}.bin`)));
const planes = planeBytes.map(view);
for (const [i, data] of planeBytes.entries()) {
  assert.equal(data.byteLength, capture.width * capture.height * (i === 4 ? 4 : 8));
  assert.equal(
    replay.checks[planeNames[i]].digest,
    hash(data),
    'atlas differs from replay receipt',
  );
  assert.equal(replay.checks[planeNames[i]].different, 0);
}
const half = (plane, pixel, channel) =>
  halfToFloat(planes[plane].getUint16(pixel * 8 + channel * 2, true));
const rows = [],
  counts = { mapped: 0, unmapped: 0, stale: 0, notSurface: 0, supportTaps: [0, 0, 0, 0, 0] };
let maximumMaterialError = 0,
  maximumNormalDepthError = 0,
  borderlineSupport = 0;
for (const chain of capture.chains) {
  assert.equal(chain.lookupStride, CARD_LOOKUP_STRIDE);
  const work = model.works[chain.lookupWork];
  assert(work && work.kind === 'dispatchWorkgroups');
  assert.equal(work.bindings.find((b) => b.binding === 0)?.resourceId, chain.hitResource);
  assert.equal(work.bindings.find((b) => b.binding === 2)?.resourceId, chain.lookupResource);
  assert.equal(work.pipeline.status, 'available');
  assert(work.pipeline.shaders.some((shader) => shader.source.includes(CARD_LOOKUP_WGSL)));
  const seed = (binding) => {
    const id = work.bindings.find((b) => b.groupIndex === 0 && b.binding === binding)?.resourceId;
    const row = tape.bootstrap.find((r) => r.handleId === id);
    assert.equal(row?.initialData.length, 1, 'Card projection/settings seed missing');
    const resource = model.resources.find((r) => r.resourceId === id);
    assert(resource);
    assert(
      resource.consumers.every((consumer) => consumer.access === 'read'),
      'Card projection/settings changed after bootstrap',
    );
    const data = tape.blobs.find((b) => b.hash === row.initialData[0].hash)?.bytes;
    assert(data);
    return view(data);
  };
  const projections = seed(1),
    settings = seed(8);
  assert.equal(settings.getUint32(4, true), capture.resolution);
  const hitBytes = await read(`chain-${chain.section}-hits.bin`);
  const lookupBytes = await read(`chain-${chain.section}-lookup.bin`);
  assert.equal(hitBytes.byteLength, chain.rayCount * 64);
  assert.equal(lookupBytes.byteLength, chain.rayCount * CARD_LOOKUP_STRIDE);
  for (const [resource, workIndex] of [
    [chain.hitResource, chain.queryWork],
    [chain.lookupResource, chain.lookupWork],
  ])
    assert(
      capture.chainChecks.some(
        (check) =>
          check.resource === resource &&
          check.workIndex === workIndex &&
          check.differentBytes === 0,
      ),
    );
  const hits = view(hitBytes),
    lookup = view(lookupBytes);
  const cards = capture.entries.flatMap((entry) =>
    entry.projections.map((projection) => ({ projection, instance: entry.instanceId })),
  );
  assert.equal(settings.getUint32(0, true), cards.length);
  assert.equal(projections.byteLength, Math.max(1, cards.length) * 80);
  for (let ray = 0; ray < chain.rayCount; ray++) {
    const offset = ray * CARD_LOOKUP_STRIDE,
      status = lookup.getUint32(offset, true);
    const card = lookup.getUint32(offset + 8, true),
      instance = lookup.getUint32(offset + 12, true);
    assert(status <= 3);
    assert.equal(lookup.getUint32(offset + 4, true), hits.getUint32(ray * 64, true));
    assert.equal(instance, hits.getUint32(ray * 64 + 4, true));
    const texels = Array.from({ length: 4 }, (_, i) => lookup.getUint32(offset + 80 + i * 4, true));
    const weights = Array.from({ length: 4 }, (_, i) =>
      lookup.getFloat32(offset + 96 + i * 4, true),
    );
    const support = weights.filter((weight) => weight > 0).length;
    // Normalized f32 division may exceed one by one ULP on the GPU.
    assert(weights.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1 + 1e-6));
    const sum = weights.reduce((a, b) => a + b, 0);
    assert(Math.abs(sum - (status === 1 ? 1 : 0)) <= 1e-6);
    counts[['notSurface', 'mapped', 'unmapped', 'stale'][status]]++;
    counts.supportTaps[support]++;
    let geometry = null;
    if (status === 1) {
      assert.equal(cards[card]?.instance, instance);
      assert.equal(projections.getUint32(card * 80 + 64, true), instance);
      assert.equal(projections.getUint32(card * 80 + 68, true), 1, 'selected Card is stale');
      const columns = capture.width / capture.resolution;
      for (let tap = 0; tap < 4; tap++) {
        if (weights[tap] === 0) {
          assert.equal(texels[tap], 0xffffffff);
          continue;
        }
        const pixel = texels[tap],
          x = pixel % capture.width,
          y = Math.floor(pixel / capture.width);
        assert(pixel < capture.width * capture.height);
        assert.equal(Math.floor(x / capture.resolution), card % columns);
        assert.equal(Math.floor(y / capture.resolution), Math.floor(card / columns));
        assert.equal(half(3, pixel, 3), 1);
      }
      geometry = inspectCardSupport({
        projection: Array.from({ length: 16 }, (_, i) =>
          projections.getFloat32(card * 80 + i * 4, true),
        ),
        position: [0, 1, 2].map((i) => hits.getFloat32(ray * 64 + 32 + i * 4, true)),
        hitNormal: [0, 1, 2].map((i) => hits.getFloat32(ray * 64 + 48 + i * 4, true)),
        allowance: hits.getFloat32(ray * 64 + 20, true),
        resolution: capture.resolution,
        width: capture.width,
        card,
        texels,
        weights,
        readNormal: (pixel) => [0, 1, 2, 3].map((i) => half(1, pixel, i)),
        readDepth: (pixel) => planes[4].getFloat32(pixel * 4, true),
        outputNormalDepth: [0, 1, 2, 3].map((i) => lookup.getFloat32(offset + 32 + i * 4, true)),
      });
      maximumNormalDepthError = Math.max(maximumNormalDepthError, geometry.reconstructionError);
      if (geometry.borderline) borderlineSupport++;
      for (const [plane, output, channels] of [
        [0, 16, 4],
        [2, 48, 4],
        [3, 64, 3],
      ])
        for (let channel = 0; channel < channels; channel++) {
          const expected = weights.reduce(
            (sum, weight, tap) =>
              weight === 0 ? sum : sum + weight * half(plane, texels[tap], channel),
            0,
          );
          const actual = lookup.getFloat32(offset + output + channel * 4, true);
          const error = Math.abs(actual - expected);
          assert(
            error <= 2e-6 * Math.max(1, Math.abs(expected)),
            `weighted material mismatch at ray ${ray}`,
          );
          maximumMaterialError = Math.max(maximumMaterialError, error);
        }
    } else assert(texels.every((pixel) => pixel === 0xffffffff));
    rows.push({
      section: chain.section,
      ray,
      status,
      card,
      instance,
      texels,
      weights,
      geometry,
      albedo: [0, 1, 2].map((channel) => lookup.getFloat32(offset + 16 + channel * 4, true)),
    });
  }
}
const report = {
  scope:
    'Offline inspection of GPU-selected Card support using tape projection/settings seeds and replay-checked atlas/hit readbacks. Checks material, normal/depth reconstruction and selected geometry constraints; reports actual texel world positions, their weighted centroid and f32 boundary slack. The centroid can lie between surfaces. Does not prove candidate selection, geometric first-hit or GI correctness.',
  tapeDigest: capture.tapeDigest,
  lookupStride: CARD_LOOKUP_STRIDE,
  counts,
  maximumMaterialError,
  maximumNormalDepthError,
  borderlineSupport,
  planeDigests: Object.fromEntries(planeNames.map((name, i) => [name, hash(planeBytes[i])])),
  rows,
};
await writeFile(
  resolve(directory, 'lookup-inspection.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({ counts, maximumMaterialError, maximumNormalDepthError, borderlineSupport }),
);
