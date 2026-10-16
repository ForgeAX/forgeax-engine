import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import UPNG from 'upng-js';
import { triangleDistanceSquared } from '../../../packages/geometry/src/triangle-query.ts';
import { surfaceCardKey } from '../../../packages/render/src/raytracing/surface-cards.ts';
import { resolveVisibleSurface } from '../../../packages/render/src/raytracing/visible-surface.ts';

if (process.argv.length < 6)
  throw new TypeError(
    'Usage: bun inspect-raster-card-coverage.mjs <prepared> <card-capture> <raster-capture> <output> [frame=baseline] [--no-cards] [--bilinear]',
  );
const [input, atlas, raster, output] = process.argv.slice(2, 6).map((p) => resolve(p));
const name = process.argv.slice(6).find((argument) => !argument.startsWith('--')) ?? 'baseline';
const bilinear = process.argv.includes('--bilinear');
await mkdir(output, { recursive: true });
const json = async (dir, file) => JSON.parse(await readFile(resolve(dir, file), 'utf8'));
const bytes = async (dir, file) => new Uint8Array(await readFile(resolve(dir, file)));
const hash = async (path) => {
  const h = createHash('sha256');
  for await (const b of createReadStream(path)) h.update(b);
  return h.digest('hex');
};
const metadata = await json(input, 'prepared.json'),
  sources = (await json(input, 'cards.json')).sources;
const capture = await json(atlas, 'capture.json'),
  live = await json(raster, `${name}.json`),
  replay = await json(raster, `${name}-browser-replay.json`);
const cardReplay = await json(atlas, 'replay.json');
assert.equal(cardReplay.tapeDigest, capture.tapeDigest);
assert.equal(capture.tapeDigest, `sha256:${await hash(resolve(atlas, 'cards.rhitape'))}`);
assert.deepEqual(cardReplay.gpuErrors, []);
assert.deepEqual(cardReplay.errors, []);
assert.deepEqual(Object.keys(cardReplay.checks).sort(), [
  'albedoRoughness',
  'depth',
  'emissionMetallic',
  'f0Validity',
  'normals',
]);
for (const [plane, check] of Object.entries(cardReplay.checks)) {
  assert.equal(check.different, 0);
  assert.equal(check.digest, `sha256:${await hash(resolve(atlas, `${plane}.bin`))}`);
}
assert.equal(capture.entries.length, sources.length);
assert.equal(new Set(capture.entries.map((entry) => entry.instanceId)).size, sources.length);
assert.equal(
  capture.works.length,
  capture.entries.reduce(
    (count, entry) =>
      count +
      entry.projections.length *
        sources.find((s) => s.instance.instanceId === entry.instanceId).sections.length,
    0,
  ),
);
for (const entry of capture.entries) {
  const source = sources.find((s) => s.instance.instanceId === entry.instanceId);
  assert(source);
  assert.equal(
    createHash('sha256').update(surfaceCardKey(source)).digest('hex'),
    entry.captureKeySha256,
  );
}
assert.equal(replay.stages.visibleSurface.differentBytes, 0);
assert.equal(replay.stages.liveHdrDifferentBytes, 0);
assert(replay.channels.every((c) => c.max === 0));
assert.deepEqual(replay.gpuErrors, []);
assert.deepEqual(replay.errors, []);
assert.equal(replay.digest, `sha256:${await hash(resolve(raster, `${name}.rhitape`))}`);
assert.equal(await hash(metadata.report.source), metadata.report.sourceSha256);
// This file diagnoses one undeformed imported mesh instance. Reject an ambiguous
// join instead of assuming draw IDs are globally interchangeable with source IDs.
assert.equal(live.report.scene.projectionRecords, 1, 'requires one retained mesh instance');
assert.equal(sources.length, 1, 'requires one source mesh instance');
const source = sources[0];
const records = new Uint32Array(
  (await bytes(raster, `${name}-visible-surface-records.u32`)).buffer,
);
assert.equal(records.length, source.sections.length * 16);
let first = 0;
const materialHandles = new Map(),
  sourceMaterials = new Map(),
  byRow = new Map();
for (let row = 1; row <= records.length / 16; row++) {
  const identity = resolveVisibleSurface({ records }, row, 0).unwrap();
  const section = source.sections[identity.drawItemIndex];
  assert(section, 'source draw missing');
  assert.equal(identity.instanceOrdinal, 0);
  assert.equal(identity.instanceGeneration, 0);
  assert.equal(identity.assetHandle, records[8]);
  assert.equal(identity.indexed, true);
  assert.equal(identity.baseVertex, 0);
  assert.equal(identity.firstElement, first);
  assert.equal(records[(row - 1) * 16 + 10], section.indexCount);
  assert.equal(identity.firstElement, section.indexOffset);
  first += section.indexCount;
  const materialId = section.material.id;
  if (materialHandles.has(materialId))
    assert.equal(materialHandles.get(materialId), identity.materialHandle);
  if (sourceMaterials.has(identity.materialHandle))
    assert.equal(sourceMaterials.get(identity.materialHandle), materialId);
  materialHandles.set(materialId, identity.materialHandle);
  sourceMaterials.set(identity.materialHandle, materialId);
  byRow.set(row, section);
}
const depth = new Float32Array((await bytes(raster, `${name}-depth.bin`)).buffer);
const visible = new Uint32Array((await bytes(raster, `${name}-visible-surface.bin`)).buffer);
assert.equal(
  replay.stages.visibleSurface.digest,
  `sha256:${await hash(resolve(raster, `${name}-visible-surface.bin`))}`,
);
const packedAlbedo = new Uint32Array((await bytes(raster, `${name}-albedo-metallic.bin`)).buffer);
let albedoAbs = 0,
  albedoSquared = 0,
  albedoChannels = 0,
  maskedAlbedoAbs = 0,
  maskedAlbedoChannels = 0;
const view = new Float32Array((await bytes(raster, `${name}-view.bin`)).buffer);
const { width, height } = live.report;
assert.equal(depth.length, width * height);
assert.equal(visible.length, width * height * 4);
const planes = {};
for (const p of ['albedoRoughness', 'f0Validity', 'normals', 'depth']) {
  const b = await bytes(atlas, `${p}.bin`);
  planes[p] = new DataView(b.buffer);
}
const half = (v, i) => {
  const u = v.getUint16(i, true),
    e = (u >> 10) & 31,
    m = u & 1023;
  return (
    (u & 32768 ? -1 : 1) *
    (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15))
  );
};
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0),
  sub = (a, b) => a.map((v, i) => v - b[i]);
const normalize = (a) => a.map((v) => v / Math.hypot(...a));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const oct = (x, y) => {
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0)
    [x, y] = [(1 - Math.abs(y)) * Math.sign(x || 1), (1 - Math.abs(x)) * Math.sign(y || 1)];
  return normalize([x, y, z]);
};
const transform = (m, p) =>
  [0, 1, 2].map((a) => m[a] * p[0] + m[a + 4] * p[1] + m[a + 8] * p[2] + m[a + 12]);
const entries = new Map();
let next = 0;
for (const entry of process.argv.includes('--no-cards') ? [] : capture.entries)
  entries.set(entry.instanceId, { ...entry, indices: entry.projections.map(() => next++) });
const labels = [
  'background',
  'mapped',
  'no-card',
  'outside-projection',
  'normal-rejected',
  'empty-texel',
  'depth-rejected',
];
const palette = [
  [20, 25, 30],
  [40, 190, 70],
  [220, 0, 180],
  [120, 40, 220],
  [40, 100, 240],
  [240, 60, 40],
  [0, 190, 190],
];
const images = Object.fromEntries(
  ['material', 'coverage', 'alpha-materials'].map((n) => [n, new Uint8Array(width * height * 4)]),
);
const counts = Object.fromEntries(labels.map((n) => [n, 0])),
  maskedCounts = { ...counts },
  perSection = {};
const stateBytes = new Uint8Array(width * height),
  provenance = new Uint32Array(width * height * 4).fill(0xffffffff);
const columns = capture.width / capture.resolution;
const cardWorkIndices = source.layout.cards.map((_, card) =>
  source.sections.map(
    (__, section) => capture.works[section * source.layout.cards.length + card].workIndex,
  ),
);
let geometryMaxDistance = 0,
  normalMinAlignment = 1,
  maskedPixels = 0;
const begin = performance.now();
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const i = y * width + x,
      row = visible[i * 4],
      primitive = visible[i * 4 + 1],
      packed = visible[i * 4 + 2],
      flags = visible[i * 4 + 3];
    let filteredColor = null;
    let state = 0,
      selectedCard = -1,
      best = -Infinity,
      masked = false;
    assert.equal(Boolean(flags & 1), depth[i] > 0, 'depth and retained coverage disagree');
    if (flags & 1) {
      resolveVisibleSurface({ records }, row, primitive).unwrap();
      const section = byRow.get(row);
      assert(section);
      const instance = source.instance;
      masked = metadata.report.maskedMaterials.includes(section.material.id);
      if (masked) maskedPixels++;
      const clip = [(2 * (x + 0.5)) / width - 1, 1 - (2 * (y + 0.5)) / height, depth[i], 1];
      const p4 = [0, 1, 2, 3].map((a) =>
        clip.reduce((sum, v, c) => sum + v * view[44 + c * 4 + a], 0),
      );
      const position = p4.slice(0, 3).map((v) => v / p4[3]);
      assert(position.every(Number.isFinite));
      const normal = oct(
        ((packed & 4095) * 2) / 4095 - 1,
        (((packed >>> 12) & 4095) * 2) / 4095 - 1,
      );
      const tri = [0, 1, 2].map((c) => {
        const v = instance.indices[section.indexOffset + primitive * 3 + c] * 3;
        return transform(instance.transform, instance.positions.slice(v, v + 3));
      });
      const distance = Math.sqrt(triangleDistanceSquared(position, tri));
      geometryMaxDistance = Math.max(geometryMaxDistance, distance);
      assert(distance < 0.002, `source/raster geometry mismatch at ${x},${y}: ${distance}`);
      const alignment = Math.abs(
        dot(normal, normalize(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])))),
      );
      normalMinAlignment = Math.min(normalMinAlignment, alignment);
      assert(alignment > 0.999, 'source primitive and GPU geometric normal disagree');
      const entry = entries.get(instance.instanceId);
      state = entry?.projections.length ? 3 : 2;
      if (entry)
        for (const [local, p] of entry.projections.entries()) {
          const rel = sub(position, p.origin),
            uv = [dot(rel, p.u) / p.width, dot(rel, p.v) / p.height];
          if (uv.some((v) => v < 0 || v >= 1)) continue;
          const angle = dot(normal, p.n);
          if (angle < 0.5) {
            if (state === 3) state = 4;
            continue;
          }
          const card = entry.indices[local];
          const tileX = (card % columns) * capture.resolution;
          const tileY = Math.floor(card / columns) * capture.resolution;
          const xy = uv.map((v) =>
            Math.max(0, Math.min(capture.resolution - 1, v * capture.resolution - 0.5)),
          );
          const lo = xy.map(Math.floor),
            f = xy.map((v, a) => v - lo[a]);
          const tolerance =
            (0.5 * Math.hypot(p.width, p.height)) / capture.resolution + p.depth / 1024;
          let sum = 0,
            depthSum = 0;
          const rgb = [0, 0, 0];
          // UE SampleLumenCard normalizes depth-qualified bilinear weights.
          // Here only tap selection changes: existing angle/normal/depth thresholds
          // and nearest-card choice stay fixed to isolate the sampling difference.
          const taps = bilinear
            ? [0, 1, 2, 3].map((i) => {
                const ox = i % 2,
                  oy = Math.floor(i / 2);
                return [
                  Math.min(capture.resolution - 1, lo[0] + ox),
                  Math.min(capture.resolution - 1, lo[1] + oy),
                  (ox ? f[0] : 1 - f[0]) * (oy ? f[1] : 1 - f[1]),
                ];
              })
            : [[Math.floor(uv[0] * capture.resolution), Math.floor(uv[1] * capture.resolution), 1]];
          for (const [tx, ty, weight] of taps) {
            if (weight === 0) continue;
            const px = tileX + tx;
            const py = tileY + ty;
            const offset = py * capture.width + px;
            if (half(planes.f0Validity, offset * 8 + 6) !== 1) {
              if (state !== 1) state = 5;
              continue;
            }
            const ng = oct(
              half(planes.normals, offset * 8 + 4),
              half(planes.normals, offset * 8 + 6),
            );
            if (dot(ng, normal) < 0.5) {
              if (state !== 1) state = 4;
              continue;
            }
            const delta = Math.abs(
              -dot(rel, p.n) - planes.depth.getFloat32(offset * 4, true) * p.depth,
            );
            if (delta > tolerance) {
              if (state !== 1) state = 6;
              continue;
            }
            for (let c = 0; c < 3; c++)
              rgb[c] += weight * half(planes.albedoRoughness, offset * 8 + c * 2);
            sum += weight;
            depthSum += weight * delta;
          }
          if (sum <= 0) continue;
          const score = angle - (depthSum / sum / Math.max(tolerance, 1e-8)) * 0.1;
          if (score > best) {
            best = score;
            selectedCard = card;
            state = 1;
            filteredColor = rgb.map((v) => v / sum);
          }
        }
      provenance.set(
        [
          instance.instanceId,
          section.indexOffset / 3 + primitive,
          selectedCard < 0 ? 0xffffffff : selectedCard,
          selectedCard < 0 ? 0xffffffff : cardWorkIndices[selectedCard].at(-1),
        ],
        i * 4,
      );
      perSection[row - 1] ??= {
        instanceId: instance.instanceId,
        materialId: section.material.id,
        alphaTested: masked,
        visible: 0,
        mapped: 0,
      };
      perSection[row - 1].visible++;
      if (state === 1) perSection[row - 1].mapped++;
    }
    if (state === 1)
      for (let c = 0; c < 3; c++) {
        const reference = (((packedAlbedo[i] >>> (c * 8)) & 255) / 255) ** 2;
        const error = Math.abs(filteredColor[c] - reference);
        albedoAbs += error;
        albedoSquared += error * error;
        albedoChannels++;
        if (masked) {
          maskedAlbedoAbs += error;
          maskedAlbedoChannels++;
        }
      }
    counts[labels[state]]++;
    if (masked) maskedCounts[labels[state]]++;
    stateBytes[i] = state;
    const color =
      state === 1
        ? [0, 1, 2].map((c) => {
            const v = Math.max(0, filteredColor[c]);
            return Math.round(
              Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255,
            );
          })
        : palette[state];
    images.material.set([...color, 255], i * 4);
    images.coverage.set([...palette[state], 255], i * 4);
    images['alpha-materials'].set(
      [...(masked ? [230, 170, 40] : flags & 1 ? [70, 70, 70] : palette[0]), 255],
      i * 4,
    );
  }
const elapsedMs = performance.now() - begin;
for (const [label, pixels] of Object.entries(images))
  await writeFile(
    resolve(output, `${label}.png`),
    new Uint8Array(UPNG.encode([pixels.buffer], width, height, 0)),
  );
await writeFile(resolve(output, 'coverage.bin'), stateBytes);
await writeFile(resolve(output, 'provenance.u32'), new Uint8Array(provenance.buffer));
const report = {
  materialError: {
    meanAbsolute: albedoChannels ? albedoAbs / albedoChannels : null,
    rms: albedoChannels ? Math.sqrt(albedoSquared / albedoChannels) : null,
    maskMeanAbsolute: maskedAlbedoChannels ? maskedAlbedoAbs / maskedAlbedoChannels : null,
    limitation:
      'Mapped pixels only; view-dependent footprint and quantization differ. Not GI error.',
  },
  scope:
    'Actual raster depth/visible-surface identity and geometric normal, including surviving MASK fragments, sample the frozen GPU card atlas on CPU. One imported rigid mesh instance; no CPU primary visibility search. This is not SDF/GI or full-scene coverage acceptance.',
  sampling: bilinear ? 'bilinear-qualified' : 'nearest',
  samplingScope:
    'Within one tile, normalize only valid normal/depth-qualified weights; original thresholds; not UE-equivalent radiance sampling.',
  rasterTape: replay.digest,
  cardTape: capture.tapeDigest,
  sourceSha256: metadata.report.sourceSha256,
  width,
  height,
  camera: live.report.camera,
  labels,
  palette,
  counts,
  maskedPixels,
  maskedCounts,
  perSection,
  geometryMaxDistance,
  normalMinAlignment,
  geometryTolerance: 0.002,
  provenanceWords: ['meshInstanceId', 'meshPrimitive', 'cardIndex', 'cardLastWorkIndex'],
  cardWorkIndices,
  workScope:
    'All candidate section draws for each card; last work is a replay boundary, not a claim that the last section won every texel.',
  rasterGeometryWorkIndex: replay.stages.geometryWorks.at(-1),
  elapsedMs,
  control: process.argv.includes('--no-cards') ? 'no-cards' : null,
};
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    counts,
    maskedPixels,
    maskedCounts,
    geometryMaxDistance,
    normalMinAlignment,
    elapsedMs,
  }),
);
