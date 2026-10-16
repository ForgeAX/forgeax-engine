import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import {
  createRayPathTracer,
  createRayReferenceQuery,
  traceReferenceRay,
} from '../../../packages/render/dist/internal.mjs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { readBuffer } from '../scene/render.mjs';
import { rasterTriangleWitness } from './raster-receiver.mjs';
import { createGltfResources } from './resources.mjs';

const preparedDirectory = resolve(process.argv[2] ?? 'artifacts/sponza-hybrid');
const sparseDirectory = resolve(process.argv[3] ?? 'artifacts/sponza-hybrid/sparse');
const out = resolve(process.argv[4] ?? 'artifacts/sponza-hybrid/material-hit');
await mkdir(out, { recursive: true });
const prepared = JSON.parse(await readFile(resolve(preparedDirectory, 'prepared.json'), 'utf8'));
const sourceBytes = await readFile(resolve(sparseDirectory, 'rays.json'));
const source = JSON.parse(sourceBytes.toString('utf8'));
const rays = source.rays.map((r) => ({
  origin: r.origin,
  direction: r.direction,
  active: r.mask !== 0,
  coneWidth: r.coneWidth,
  coneSpread: r.coneSpread,
}));
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: create([]) }, configurable: true });
const recorder = attachRecorder(gpu).unwrap();
const device = (
  await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
).unwrap();
const rawDevice = gpu._internal_getRawDevice(device._realDevice),
  errors = [];
rawDevice.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const resources = await createGltfResources(
  device,
  recorder.backend.createShaderModule,
  prepared,
  async (name) => new Uint8Array(await readFile(resolve(preparedDirectory, name))),
  console.log,
);
const tracers = [],
  outputs = [];
let tape, receiverOutput, receiverValidation;
try {
  const receiverRays = source.samples.map((sample) => {
    const delta = sample.position.map((v, c) => v - source.eye[c]),
      distance = Math.hypot(...delta);
    const direction = delta.map((v) => v / distance);
    const cosine = Math.abs(
      direction.reduce((sum, v, c) => sum + v * sample.geometricNormal[c], 0),
    );
    const radius = (sample.footprint * 0.25) / Math.max(0.05, cosine);
    return {
      origin: source.eye,
      direction,
      tMin: Math.max(0, distance - radius),
      tMax: distance + radius,
      mask: 255,
    };
  });
  // The raster pass already owns primary coverage. This narrow geometry probe
  // locates its triangle; re-evaluating primary MASK with a ray cone would use
  // a different footprint than the authoritative raster fragment.
  const receiver = (
    await createRayReferenceQuery(
      device,
      recorder.backend.createShaderModule,
      resources.scene,
      receiverRays,
    )
  ).unwrap();
  tracers.push(receiver);
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  console.log('Resolving the raster receiver triangle in its captured depth interval');
  const receiverEncoder = device.createCommandEncoder({}).unwrap();
  receiver.record(receiverEncoder).unwrap();
  device.queue.submit([receiverEncoder.finish().unwrap()]).unwrap();
  receiverOutput = await readBuffer(device, receiver.buffers.hits, receiverRays.length * 32);
  await writeFile(resolve(out, 'receiver-hits.bin'), receiverOutput);
  const hits = new DataView(
    receiverOutput.buffer,
    receiverOutput.byteOffset,
    receiverOutput.byteLength,
  );
  const tri = new DataView(
    resources.scene.triangles.buffer,
    resources.scene.triangles.byteOffset,
    resources.scene.triangles.byteLength,
  );
  const key = (instance, primitive) => `${instance}:${primitive}`;
  const indices = new Map();
  for (let i = 0; i < source.samples.length; i++)
    indices.set(key(hits.getUint32(i * 32, true), hits.getUint32(i * 32 + 8, true)), -1);
  for (let i = 0; i < resources.scene.triangleCount; i++) {
    const k = key(tri.getUint32(i * 80 + 48, true), tri.getUint32(i * 80 + 56, true));
    if (indices.has(k)) indices.set(k, i);
  }
  const mismatches = [],
    rasterResolved = [];
  let maximumPositionError = 0,
    maximumSnappedDepthError = 0;
  const dot = (a, b) => a.reduce((sum, v, c) => sum + v * b[c], 0);
  const vertices = (index) =>
    [0, 16, 32].map((offset) =>
      [0, 4, 8].map((c) => tri.getFloat32(index * 80 + offset + c, true)),
    );
  for (const [i, sample] of source.samples.entries()) {
    let index = indices.get(key(hits.getUint32(i * 32, true), hits.getUint32(i * 32 + 8, true)));
    let witness = index >= 0 ? rasterTriangleWitness(vertices(index), sample, source) : null;
    if (!witness || witness.error > 1e-7) {
      // Tiny triangles can change coverage after vertex snapping. Search the
      // source only for an offline depth witness; never accept the wrong face
      // by increasing the original residual bound.
      witness = null;
      for (let candidate = 0; candidate < resources.scene.triangleCount; candidate++) {
        const hit = rasterTriangleWitness(vertices(candidate), sample, source);
        if (hit && hit.error <= 1e-7 && (!witness || hit.error < witness.error)) {
          witness = hit;
          index = candidate;
        }
      }
      if (witness)
        rasterResolved.push({ sample: i, triangle: index, depthResidual: witness.error });
    }
    if (!witness) {
      mismatches.push({
        sample: i,
        pixel: [sample.x, sample.y],
        reason: 'no triangle reproduces the captured raster depth',
      });
      for (let r = sample.first; r < sample.first + sample.count; r++) rays[r].active = false;
      continue;
    }
    const { position, normal, error } = witness;
    maximumPositionError = Math.max(
      maximumPositionError,
      Math.hypot(...position.map((v, c) => v - sample.position[c])),
    );
    maximumSnappedDepthError = Math.max(maximumSnappedDepthError, error);
    sample.resolvedIdentity = [
      tri.getUint32(index * 80 + 48, true),
      tri.getUint32(index * 80 + 56, true),
    ];
    sample.resolvedPosition = position;
    sample.resolvedNormal = normal;
    for (let r = sample.first; r < sample.first + sample.count; r++) {
      rays[r].origin = position.map((v, c) => v + normal[c] * sample.bias);
      rays[r].active = dot(rays[r].direction, normal) > 0;
    }
  }
  receiverValidation = {
    samples: receiverRays.length,
    qualified: receiverRays.length - mismatches.length,
    status: mismatches.length ? 'incomplete' : 'complete',
    rasterSubpixelGrid: 16,
    rasterResolved,
    maximumPositionError,
    maximumSnappedDepthError,
    mismatches,
  };
  await writeFile(
    resolve(out, 'receiver-checks.json'),
    JSON.stringify(receiverValidation, null, 2),
  );
  await writeFile(resolve(out, 'initial-rays.json'), JSON.stringify(rays));
  for (const light of [1, 0]) {
    console.log(`Preparing shared-material initial rays, sun=${light}`);
    tracers.push(
      (
        await createRayPathTracer(device, recorder.backend.createShaderModule, {
          kernel: prepared.kernel,
          scene: resources.scene,
          materials: prepared.materials,
          resolveTexture: resources.resolveTexture,
          lights: [
            {
              kind: 'directional',
              direction: new Float32Array([0.45, -1, -0.2]),
              color: new Float32Array([4 * light, 0.95 * 4 * light, 0.85 * 4 * light]),
              intensity: 4 * light,
            },
          ],
          settings: {
            width: rays.length,
            height: 1,
            rays,
            maxBounces: 1,
            seed: 47,
            environment: [0, 0, 0],
            maxDistance: 120,
          },
        })
      ).unwrap(),
    );
  }
  for (const [i, tracer] of tracers.slice(1).entries()) {
    console.log(`Tracing shared hit materials, sun=${1 - i}`);
    const encoder = device.createCommandEncoder({}).unwrap();
    tracer.recordSample(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const result = {};
    for (const [key, stride] of [
      ['inputs', 224],
      ['surfaces', 96],
      ['accumulation', 80],
    ]) {
      result[key] = await readBuffer(device, tracer.buffers[key], rays.length * stride);
      await writeFile(resolve(out, `${i ? 'light-off' : 'baseline'}-${key}.bin`), result[key]);
    }
    outputs.push(result);
  }
  (await recorder.frameBoundary()).unwrap();
  tape = (await pending).unwrap();
} finally {
  await device.queue.onSubmittedWorkDone();
  for (const tracer of tracers) tracer.dispose();
  resources.dispose();
  (await recorder.dispose()).unwrap();
  rawDevice.destroy();
}
await writeFile(resolve(out, 'material-hit.rhitape'), tape.bytes);
const counts = outputs.map((result) => {
  const a = new DataView(
    result.accumulation.buffer,
    result.accumulation.byteOffset,
    result.accumulation.byteLength,
  );
  const input = new DataView(
    result.inputs.buffer,
    result.inputs.byteOffset,
    result.inputs.byteLength,
  );
  const surface = new DataView(
    result.surfaces.buffer,
    result.surfaces.byteOffset,
    result.surfaces.byteLength,
  );
  let hits = 0,
    maskedHits = 0,
    misses = 0,
    nulls = 0,
    energy = 0,
    nearOriginHits = 0;
  const nearOriginWitnesses = [];
  for (let i = 0; i < rays.length; i++) {
    assert.equal(a.getUint32(i * 80 + 12, true), 1, `Missing sample ${i}`);
    assert.equal(a.getUint32(i * 80 + 28, true), 0, `Invalid material/coverage sample ${i}`);
    for (let c = 0; c < 3; c++) {
      const value = a.getFloat32(i * 80 + c * 4, true);
      assert(Number.isFinite(value) && value >= 0);
      energy += value;
    }
    if (!rays[i].active) {
      nulls++;
      for (let c = 0; c < 3; c++) assert.equal(a.getFloat32(i * 80 + c * 4, true), 0);
      continue;
    }
    if (a.getUint32(i * 80 + 64, true) === 0xffffffff) {
      misses++;
      continue;
    }
    hits++;
    const material = input.getUint32(i * 224 + 208, true);
    assert(material < prepared.report.materials);
    assert.equal(surface.getUint32(i * 96 + 64, true), 1);
    if (prepared.report.maskedMaterials.includes(material)) maskedHits++;
    const distance = input.getFloat32(i * 224 + 28, true);
    assert(Number.isFinite(distance) && distance >= 0);
    if (distance < source.samples[Math.floor(i / source.samples[0].count)].bias * 4) {
      nearOriginHits++;
      const sample = source.samples[Math.floor(i / source.samples[0].count)];
      const identity = [a.getUint32(i * 80 + 64, true), a.getUint32(i * 80 + 72, true)];
      assert.notDeepEqual(
        identity,
        sample.resolvedIdentity,
        'A receiver cannot hit its source triangle',
      );
      const witness = traceReferenceRay(resources.scene, {
        ...rays[i],
        tMin: 0,
        tMax: 120,
        mask: 255,
      });
      assert(witness);
      assert.deepEqual(identity, [witness.instanceId, witness.primitiveId]);
      assert(Math.abs(witness.t - distance) < 1e-6);
      nearOriginWitnesses.push({
        ray: i,
        receiver: sample.resolvedIdentity,
        hit: identity,
        distance,
        cpuDistance: witness.t,
      });
    }
    for (let c = 0; c < 3; c++) {
      const position = input.getFloat32(i * 224 + 16 + c * 4, true);
      assert(Math.abs(position - (rays[i].origin[c] + rays[i].direction[c] * distance)) < 1e-3);
    }
    const normal = [0, 1, 2].map((c) => surface.getFloat32(i * 96 + 16 + c * 4, true));
    assert(Math.abs(Math.hypot(...normal) - 1) < 1e-4);
  }
  return { hits, maskedHits, misses, nulls, nearOriginHits, nearOriginWitnesses, energy };
});
assert(counts[0].energy > 0);
assert.equal(counts[0].nearOriginHits, counts[0].nearOriginWitnesses.length);
assert.equal(counts[1].energy, 0);
assert.deepEqual(outputs[0].inputs, outputs[1].inputs);
assert.deepEqual(outputs[0].surfaces, outputs[1].surfaces);
const decoded = decodeTape(tape.bytes).unwrap(),
  model = buildFrameModel(decoded);
const works = model.works.filter((w) =>
  w.pipeline.shaders.some((s) => s.entryPoint === 'accumulate'),
);
assert.equal(works.length, 2);
const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
const replay = (
  await openReplay(decoded, { device: fresh, createShaderModule: gpu.createShaderModule })
).unwrap();
const checks = [];
try {
  const receiverResource = model.works[0].bindings.find((b) => b.binding === 3).resourceId;
  assert.deepEqual(
    (await replay.readResourceAtWork(receiverResource, 0)).unwrap().bytes,
    receiverOutput,
  );
  checks.push({
    workIndex: 0,
    resourceId: receiverResource,
    role: 'raster-receiver-triangles',
    byteEquality: true,
  });
  for (const [i, w] of works.entries())
    for (const [key, binding] of [
      ['inputs', 4],
      ['surfaces', 5],
      ['accumulation', 6],
    ]) {
      const id = w.bindings.find((b) => b.binding === binding).resourceId;
      assert.deepEqual(
        (await replay.readResourceAtWork(id, w.workIndex)).unwrap().bytes,
        outputs[i][key],
      );
      checks.push({ workIndex: w.workIndex, resourceId: id, role: key, byteEquality: true });
    }
} finally {
  (await replay.dispose()).unwrap();
  gpu._internal_getRawDevice(fresh).destroy();
}
assert.deepEqual(errors, []);
const report = {
  receiverValidation,
  scope:
    'One shared-material surface bounce from sparse raster receivers; main visible direct light remains rasterized',
  sourceTape: source.sourceTape,
  sourceRays: createHash('sha256').update(sourceBytes).digest('hex'),
  tape: tape.digest,
  rays: rays.length,
  receivers: source.samples.length,
  counts,
  checks,
  errors,
};
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
