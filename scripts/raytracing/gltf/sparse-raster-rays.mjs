import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import { writeReferencePng } from '../../../apps/shared/png-codec.mjs';
import {
  createRayReferenceQuery,
  traceReferenceRay,
} from '../../../packages/render/dist/internal.mjs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  tapeDigest,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { readBuffer } from '../scene/render.mjs';

const raster = resolve(process.argv[2] ?? 'artifacts/sponza-raster/controls-384');
const preparedDirectory = resolve(process.argv[3] ?? 'artifacts/sponza-hybrid');
const out = resolve(process.argv[4] ?? 'artifacts/sponza-hybrid/sparse');
await mkdir(out, { recursive: true });
const load = async (root, name) => new Uint8Array(await readFile(resolve(root, name)));
const capture = JSON.parse(await readFile(resolve(raster, 'baseline.json'), 'utf8'));
const replayProof = JSON.parse(
  await readFile(resolve(raster, 'baseline-browser-replay.json'), 'utf8'),
);
assert.equal(replayProof.stages.liveHdrDifferentBytes, 0);
assert(replayProof.channels.every((c) => c.max === 0));
const prepared = JSON.parse(await readFile(resolve(preparedDirectory, 'prepared.json'), 'utf8'));
assert.equal(
  createHash('sha256')
    .update(await readFile(prepared.report.source))
    .digest('hex'),
  prepared.report.sourceSha256,
);
const sourceTape = await load(raster, 'baseline.rhitape');
assert.equal(tapeDigest(sourceTape), replayProof.digest);
const scene = {
  ...prepared.scene,
  triangles: await load(preparedDirectory, 'triangles.bin'),
  nodes: await load(preparedDirectory, 'nodes.bin'),
};
const depth = new Float32Array((await load(raster, 'baseline-depth.bin')).buffer);
const packedNormal = new Uint32Array((await load(raster, 'baseline-normal-roughness.bin')).buffer);
const view = new Float32Array((await load(raster, 'baseline-view.bin')).buffer);
const width = capture.report.width,
  height = capture.report.height;
const eye = Array.from(view.slice(24, 27));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map((v) => v * s);
const normalize = (a) => scale(a, 1 / Math.hypot(...a));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const mul = (m, v) => [0, 1, 2, 3].map((r) => v.reduce((s, x, c) => s + x * m[c * 4 + r], 0));
const position = (x, y) => {
  const d = depth[y * width + x];
  if (!(d > 0)) return null;
  const v = mul(view.subarray(44, 60), [
    ((x + 0.5) / width) * 2 - 1,
    1 - ((y + 0.5) / height) * 2,
    d,
    1,
  ]);
  return v.slice(0, 3).map((n) => n / v[3]);
};
const normal = (p) => {
  let x = ((p & 4095) * 2) / 4095 - 1,
    y = (((p >>> 12) & 4095) * 2) / 4095 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y),
    f = Math.max(-z, 0);
  x += x >= 0 ? -f : f;
  y += y >= 0 ? -f : f;
  return normalize([x, y, z]);
};
const rays = [],
  samples = [],
  pixels = new Uint8Array(width * height * 4);
for (let i = 0; i < pixels.length; i += 4) pixels[i + 3] = 255;
let rejectedBackground = 0,
  rejectedEdge = 0,
  nullDirections = 0;
const step = Number(process.argv[5] ?? 16),
  directions = Number(process.argv[6] ?? 16);
assert(Number.isInteger(step) && step >= 2 && width % step === 0 && height % step === 0);
assert(Number.isInteger(directions) && directions >= 1 && directions <= 64);
assert(((width * height) / (step * step)) * directions <= 65536);
const offset = Math.floor(step / 2);
for (let y = offset; y < height - 1; y += step)
  for (let x = offset; x < width - 1; x += step) {
    const p = position(x, y);
    if (!p) {
      rejectedBackground++;
      continue;
    }
    const n = normal(packedNormal[y * width + x]);
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ].map(([x, y]) => position(x, y));
    if (neighbors.some((v) => v === null)) {
      rejectedEdge++;
      continue;
    }
    const dx = [sub(p, neighbors[0]), sub(neighbors[1], p)].sort(
      (a, b) => dot(a, a) - dot(b, b),
    )[0];
    const dy = [sub(p, neighbors[2]), sub(neighbors[3], p)].sort(
      (a, b) => dot(a, a) - dot(b, b),
    )[0];
    let ng = normalize(cross(dx, dy));
    if (dot(ng, sub(eye, p)) < 0) ng = scale(ng, -1);
    // Depth discontinuities cannot supply a trustworthy geometric normal.
    const footprint =
      (Math.hypot(...sub(eye, p)) * 2 * Math.tan(capture.report.camera.verticalFov / 2)) / height;
    if (
      !ng.every(Number.isFinite) ||
      Math.max(Math.hypot(...dx), Math.hypot(...dy)) > footprint * 4 ||
      dot(ng, n) <= 0
    ) {
      rejectedEdge++;
      continue;
    }
    const clip = mul(view.subarray(0, 16), [...p, 1]);
    assert(Math.abs(((clip[0] / clip[3] + 1) * width) / 2 - (x + 0.5)) < 0.001);
    assert(Math.abs(((1 - clip[1] / clip[3]) * height) / 2 - (y + 0.5)) < 0.001);
    assert(Math.abs(clip[2] / clip[3] - depth[y * width + x]) < 1e-6);
    const bias = Math.max(1e-4, Math.max(...p.map(Math.abs)) * 1e-5);
    const origin = add(p, scale(ng, bias));
    const tangent = normalize(cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], n));
    const bitangent = cross(n, tangent);
    const first = rays.length;
    for (let s = 0; s < directions; s++) {
      const r = Math.sqrt((s + 0.5) / directions),
        phi = 2 * Math.PI * ((s * 0.6180339887498949) % 1);
      const direction = normalize(
        add(
          add(scale(tangent, r * Math.cos(phi)), scale(bitangent, r * Math.sin(phi))),
          scale(n, Math.sqrt(1 - r * r)),
        ),
      );
      const active = dot(direction, ng) > 0;
      if (!active) nullDirections++;
      assert(Math.abs(Math.hypot(...direction) - 1) < 1e-6 && dot(direction, n) > 0);
      rays.push({
        origin,
        direction,
        tMin: 0,
        tMax: 120,
        mask: active ? 255 : 0,
        coneWidth: footprint,
        coneSpread: 1,
      });
    }
    samples.push({
      x,
      y,
      position: p,
      normal: n,
      geometricNormal: ng,
      origin,
      bias,
      footprint,
      first,
      count: directions,
    });
  }
assert(samples.length > 100);
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: create([]) }, configurable: true });
const recorder = attachRecorder(gpu).unwrap();
const device = (
  await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
).unwrap();
const raw = gpu._internal_getRawDevice(device._realDevice),
  errors = [];
raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const query = (
  await createRayReferenceQuery(device, recorder.backend.createShaderModule, scene, rays)
).unwrap();
let result, tape;
try {
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const encoder = device.createCommandEncoder({}).unwrap();
  query.record(encoder).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  result = await readBuffer(device, query.buffers.hits, rays.length * 32);
  // Same output is overwritten; inspecting work zero must recover the earlier result.
  const zeroRays = new Uint8Array(rays.length * 48);
  device.queue.writeBuffer(query.buffers.rays, 0, zeroRays).unwrap();
  const clear = device.createCommandEncoder({}).unwrap();
  query.record(clear).unwrap();
  device.queue.submit([clear.finish().unwrap()]).unwrap();
  const cleared = await readBuffer(device, query.buffers.hits, rays.length * 32);
  const clearIds = new Uint32Array(cleared.buffer, cleared.byteOffset, cleared.byteLength / 4);
  assert(clearIds.every((v, i) => i % 8 >= 4 || v === 0xffffffff));
  (await recorder.frameBoundary()).unwrap();
  tape = (await pending).unwrap();
} finally {
  query.dispose();
  (await recorder.dispose()).unwrap();
  raw.destroy();
}
const hits = new DataView(result.buffer, result.byteOffset, result.byteLength);
let hitCount = 0,
  missCount = 0,
  maskedCandidates = 0;
const maskSet = new Set(prepared.report.maskedMaterials);
for (let i = 0; i < rays.length; i++) {
  const id = hits.getUint32(i * 32, true),
    t = hits.getFloat32(i * 32 + 16, true);
  if (id === 0xffffffff) {
    missCount++;
    continue;
  }
  hitCount++;
  assert(Number.isFinite(t) && t >= 0 && t <= 120);
  assert(hits.getUint32(i * 32 + 12, true) < prepared.report.materials);
  if (maskSet.has(hits.getUint32(i * 32 + 12, true))) maskedCandidates++;
}
const oracle = [];
for (let k = 0; k < 16; k++) {
  const i = Math.floor(((k + 0.5) * rays.length) / 16);
  const expected = traceReferenceRay(scene, rays[i]);
  const ids = [0, 4, 8, 12].map((o) => hits.getUint32(i * 32 + o, true));
  assert.deepEqual(
    ids,
    expected
      ? [expected.instanceId, expected.geometryId, expected.primitiveId, expected.materialId]
      : [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
  );
  if (expected) {
    const t = hits.getFloat32(i * 32 + 16, true);
    assert(Math.abs(t - expected.t) <= 1e-4 * Math.max(1, expected.t));
  }
  oracle.push({ ray: i, matched: true });
}
for (const sample of samples) {
  let h = 0,
    m = 0;
  for (let s = sample.first; s < sample.first + sample.count; s++)
    if (hits.getUint32(s * 32, true) !== 0xffffffff) {
      h++;
      if (maskSet.has(hits.getUint32(s * 32 + 12, true))) m++;
    }
  const radius = Math.min(3, Math.floor((step - 1) / 2));
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const i = ((sample.y + dy) * width + sample.x + dx) * 4;
      pixels[i] = m ? 220 : 30;
      pixels[i + 1] = Math.round((255 * h) / sample.count);
      pixels[i + 2] = m ? 180 : Math.round(255 * (1 - h / sample.count));
    }
}
await writeFile(resolve(out, 'sparse.rhitape'), tape.bytes);
await writeFile(resolve(out, 'hits.bin'), result);
await writeFile(
  resolve(out, 'rays.json'),
  JSON.stringify({
    sourceTape: capture.artifact.digest,
    width,
    height,
    step,
    directions,
    eye,
    viewProjection: Array.from(view.slice(0, 16)),
    verticalFov: capture.report.camera.verticalFov,
    samples: samples.map((s) => ({ ...s, depth: depth[s.y * width + s.x] })),
    rays,
  }),
);
await writeFile(resolve(out, 'sparse-coverage.png'), writeReferencePng(pixels, width, height));
const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
const replay = (
  await openReplay(decodeTape(tape.bytes).unwrap(), {
    device: fresh,
    createShaderModule: gpu.createShaderModule,
  })
).unwrap();
try {
  const output = model.works[0].bindings.find((b) => b.binding === 3).resourceId;
  assert.deepEqual(
    (await replay.readResourceAtWork(output, 0)).unwrap().bytes,
    new Uint8Array(result),
  );
  const overwritten = (await replay.readResourceAtWork(output, 1)).unwrap().bytes;
  assert.notDeepEqual(overwritten, new Uint8Array(result));
} finally {
  (await replay.dispose()).unwrap();
  gpu._internal_getRawDevice(fresh).destroy();
}
assert.deepEqual(errors, []);
const report = {
  scope:
    'Sparse opaque query diagnostic from captured raster receivers; MASK candidates unresolved, no indirect-light acceptance',
  sourceTape: capture.artifact.digest,
  tape: tape.digest,
  receivers: samples.length,
  rays: rays.length,
  rejectedBackground,
  rejectedEdge,
  nullDirections,
  hitCount,
  missCount,
  maskedCandidates,
  oracle,
  freshReplayByteEquality: true,
  overwriteFalsifier: true,
  errors,
};
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
