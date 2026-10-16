import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import UPNG from 'upng-js';
import { decodeMeshDistanceField } from '../../../packages/geometry/src/distance-field-artifact.ts';
import {
  createTriangleQuery,
  triangleDistanceSquared,
} from '../../../packages/geometry/src/triangle-query.ts';
import { mat4 } from '../../../packages/math/dist/index.mjs';
import { packSdfScene, SDF_QUERY_WGSL } from '../../../packages/render/src/raytracing/sdf-query.ts';
import { buildFrameModel, decodeTape } from '../../../packages/rhi-debug/dist/index.mjs';

const cardsPath = resolve(process.argv[2]),
  input = resolve(process.argv[3]),
  output = resolve(process.argv[4]);
const sources = JSON.parse(await readFile(cardsPath, 'utf8')).sources;
const manifest = JSON.parse(await readFile(resolve(input, 'probes.json'), 'utf8'));
const gpu = JSON.parse(await readFile(resolve(output, 'gpu.json'), 'utf8'));
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const tapeBytes = new Uint8Array(await readFile(resolve(output, 'sdf.rhitape')));
const tape = decodeTape(tapeBytes).unwrap(),
  model = buildFrameModel(tape),
  inspections = [];
assert(['clearance', 'ray-distance'].includes(gpu.visibilityExpansion));
assert.deepEqual(gpu.gpuErrors, []);
assert.deepEqual(gpu.errors, []);
assert.deepEqual(model.unseededResources, []);
assert.equal(model.works.length, manifest.rows.length);

const rows = [],
  firstIntersections = [],
  failures = [],
  size = manifest.size,
  width = size * 6,
  height = size * manifest.rows.length;
const states = new Uint8Array(width * height * 4),
  distances = states.slice();
const labels = [
  'miss',
  'surfaceBand',
  'insideStart',
  'stepBudget',
  'missingField',
  'visibilityHit',
];
const point = (m, p) =>
  [0, 1, 2].map((a) => m[a] * p[0] + m[a + 4] * p[1] + m[a + 8] * p[2] + m[a + 12]);
for (const [rowIndex, row] of manifest.rows.entries()) {
  const { instance } = sources.find((s) => s.instance.geometryId === row.section);
  const data = JSON.parse(await readFile(resolve(input, row.file), 'utf8'));
  const work = model.works[rowIndex];
  assert.equal(gpu.works[rowIndex].differentBytes, 0);
  assert.equal(work.drawCall.x, Math.ceil(row.rays / 64));
  assert.deepEqual(
    work.bindings.map((b) => b.binding),
    [0, 1, 2, 3, 4],
  );
  assert.equal(work.pipeline.status, 'available');
  assert.equal(sha(work.pipeline.shaders[0].source), sha(SDF_QUERY_WGSL));
  const seeds = work.bindings.map((b) => tape.bootstrap.find((r) => r.handleId === b.resourceId));
  assert(seeds.every((s) => s?.initialData.length === 1));
  const bytesOf = (seed) => tape.blobs.find((b) => b.hash === seed.initialData[0].hash).bytes;
  const viewOf = (seed) => {
    const b = bytesOf(seed);
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  };
  const artifact = await readFile(resolve(input, data.fieldFile));
  assert.equal(sha(artifact), `sha256:${row.artifactSha256}`);
  const field = (await decodeMeshDistanceField(artifact, data.meshDigest)).unwrap();
  const packedScene = packSdfScene([{ ...instance, field }]).unwrap();
  assert.equal(seeds[1].initialData[0].hash, sha(packedScene.fields));
  assert.equal(seeds[0].initialData[0].hash, sha(packedScene.instances));
  assert.equal(seeds[3].initialData[0].hash, sha(new Uint8Array(row.rays * 64)));
  const settings = viewOf(seeds[4]),
    packed = viewOf(seeds[0]),
    rays = viewOf(seeds[2]);
  assert.equal(settings.getUint32(0, true), 1);
  assert.equal(settings.getUint32(4, true), gpu.maxSteps);
  assert.equal(settings.getUint32(8, true), gpu.visibilityExpansion === 'ray-distance' ? 1 : 0);
  assert.deepEqual(
    Array.from({ length: 16 }, (_, i) => packed.getFloat32(i * 4, true)),
    Array.from(mat4.invert(mat4.create(), mat4.clone(instance.transform))),
  );
  assert.deepEqual(
    [64, 68, 72, 76].map((i) => packed.getUint32(i, true)),
    [instance.instanceId, instance.geometryId, 0xffffffff, instance.mask],
  );
  assert.deepEqual(
    [80, 84, 88, 92].map((i) => packed.getUint32(i, true)),
    [0, ...field.dimensions],
  );
  assert.deepEqual(
    [96, 100, 104, 108].map((i) => packed.getFloat32(i, true)),
    [...field.origin, field.spacing].map(Math.fround),
  );
  if (field.policy.kind === 'sampled-visibility') {
    assert.equal(packed.getFloat32(124, true), field.policy.distanceBand);
    assert.equal(packed.getFloat32(140, true), 1);
    assert.equal(packed.getFloat32(132, true), 0);
    assert.equal(packed.getFloat32(128, true), Math.fround((Math.sqrt(3) * field.spacing) / 2));
    assert.deepEqual(
      [112, 116, 120].map((i) => packed.getFloat32(i, true)),
      field.policy.traceBounds.max.map(Math.fround),
    );
  }
  assert.equal(rays.byteLength, data.rays.length * 48);
  for (const [i, ray] of data.rays.entries()) {
    assert.deepEqual(
      Array.from({ length: 8 }, (_, a) => rays.getFloat32(i * 48 + a * 4, true)),
      [...ray.origin, ray.tMin, ...ray.direction, ray.tMax].map(Math.fround),
    );
    assert.equal(rays.getUint32(i * 48 + 32, true), ray.mask);
  }
  inspections.push({
    workIndex: work.workIndex,
    eventIndex: work.eventIndex,
    shaderSha256: sha(work.pipeline.shaders[0].source),
    bindings: work.bindings.map((b, i) => ({ ...b, initialData: seeds[i].initialData })),
  });
  const bytes = await readFile(resolve(output, `section-${row.section}-hits.bin`));
  const budget = await readFile(resolve(output, `section-${row.section}-budget.bin`));
  assert.equal(bytes.length, row.rays * 64);
  assert.equal(budget.length, bytes.length);
  const live = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const control = new DataView(budget.buffer, budget.byteOffset, budget.byteLength);
  const triangles = [];
  for (let i = 0; i < instance.indices.length; i += 3)
    triangles.push(
      [0, 1, 2].map((v) =>
        point(
          instance.transform,
          instance.positions.slice(instance.indices[i + v] * 3, instance.indices[i + v] * 3 + 3),
        ),
      ),
    );
  const oracle = createTriangleQuery(triangles),
    counts = Object.fromEntries(labels.map((l) => [l, 0]));
  let maxWorldSurfaceDistance = 0,
    maxBandFraction = 0,
    maxLongitudinalDifference = 0,
    exactHitMisses = 0,
    expandedOnly = 0,
    exactHitsCovered = 0,
    lowStepBudget = 0,
    maxSteps = 0,
    exhaustiveChecks = 0,
    maxOracleDelta = 0;
  const exhaustivePerView = new Uint8Array(6);
  const intersections = [];
  for (let i = 0; i < row.rays; i++) {
    const offset = i * 64,
      state = live.getUint32(offset, true),
      band = live.getFloat32(offset + 20, true),
      t = live.getFloat32(offset + 16, true);
    if (!labels[state]) throw Error(`invalid GPU status ${state}`);
    counts[labels[state]]++;
    maxSteps = Math.max(maxSteps, live.getFloat32(offset + 24, true));
    if (control.getUint32(offset, true) === 3) lowStepBudget++;
    if (i === row.rays - 1) {
      assert.equal(state, 0, 'zero visibility mask must miss');
      assert.equal(control.getUint32(offset, true), 0);
      continue;
    }
    const exact = data.exact[i],
      view = Math.floor(i / (size * size));
    const ray = data.rays[i];
    const referenceHit = { primitive: -1, distance: 0, frontFace: false };
    const found = oracle.trace(referenceHit, ray.origin, ray.direction, ray.tMin, ray.tMax);
    assert.equal(found, exact !== null, 'frozen reference hit disagrees with the current oracle');
    if (found) assert(Math.abs(referenceHit.distance - exact) < 1e-5);
    let normalDot = null,
      normalLength = null;
    let fraction = 0;
    if (state === 1 || state === 5) {
      const p = [32, 36, 40].map((k) => live.getFloat32(offset + k, true));
      assert(
        p.every(Number.isFinite) && Number.isFinite(t) && (state === 5 ? band === 0 : band > 0),
      );
      assert.equal(live.getUint32(offset + 4, true), instance.instanceId);
      assert.equal(live.getUint32(offset + 8, true), instance.geometryId);
      // SDF hits identify geometry; material selection belongs to Card mapping.
      assert.equal(live.getUint32(offset + 12, true), 0xffffffff);
      const normal = [48, 52, 56].map((k) => live.getFloat32(offset + k, true));
      assert(normal.every(Number.isFinite), 'GPU hit normal must be finite');
      normalLength = Math.hypot(...normal);
      if (found) {
        const [a, b, c] = triangles[referenceHit.primitive];
        const u = b.map((value, axis) => value - a[axis]);
        const v = c.map((value, axis) => value - a[axis]);
        const cross = [
          u[1] * v[2] - u[2] * v[1],
          u[2] * v[0] - u[0] * v[2],
          u[0] * v[1] - u[1] * v[0],
        ];
        normalDot =
          normal.reduce((sum, value, axis) => sum + value * cross[axis], 0) / Math.hypot(...cross);
        assert(Number.isFinite(normalDot));
      }
      const squared = oracle.nearestSquared(p);
      assert(squared !== null);
      const nearest = Math.sqrt(squared);
      if (exhaustivePerView[view] < 4) {
        let exhaustive = Infinity;
        for (const triangle of triangles)
          exhaustive = Math.min(exhaustive, triangleDistanceSquared(p, triangle));
        const delta = Math.abs(Math.sqrt(exhaustive) - nearest);
        maxOracleDelta = Math.max(maxOracleDelta, delta);
        assert(delta < 1e-10, 'nearest oracle traversal differs from exhaustive geometry');
        exhaustiveChecks++;
        exhaustivePerView[view]++;
      }
      fraction = nearest / (state === 5 ? row.worldVoxel : band);
      maxWorldSurfaceDistance = Math.max(maxWorldSurfaceDistance, nearest);
      if (state === 1) maxBandFraction = Math.max(maxBandFraction, fraction);
      if (state === 1 && fraction > 1.00001)
        failures.push({
          section: row.section,
          ray: i,
          reason: 'world-distance-outside-reported-band',
          nearest,
          band,
        });
      if (exact === null) expandedOnly++;
      else {
        exactHitsCovered++;
        maxLongitudinalDifference = Math.max(maxLongitudinalDifference, Math.abs(t - exact));
      }
    } else if (exact !== null && state === 0) exactHitMisses++;
    const hit = state === 1 || state === 5;
    intersections.push({
      ray: i,
      state,
      reference: exact,
      referencePrimitive: found ? referenceHit.primitive : null,
      hitTime: hit ? t : null,
      delta: hit && found ? t - exact : null,
      immediate: hit && Math.abs(t - ray.tMin) < 1e-6,
      normalLength,
      normalDot,
    });
    const x = view * size + (i % size),
      y = rowIndex * size + Math.floor((i % (size * size)) / size),
      pixel = (y * width + x) * 4;
    const color =
      state === 1 || state === 5
        ? exact === null
          ? [236, 164, 48]
          : [50, 202, 152]
        : state === 0
          ? exact === null
            ? [18, 24, 36]
            : [255, 30, 80]
          : [190, 75, 230];
    states.set([...color, 255], pixel);
    distances.set(
      state === 1 || state === 5
        ? [
            Math.round(255 * Math.min(1, fraction)),
            Math.round(220 * (1 - Math.min(1, fraction))),
            70,
            255,
          ]
        : [...color, 255],
      pixel,
    );
  }
  if (exactHitMisses || counts.insideStart || counts.missingField || counts.stepBudget)
    failures.push({ section: row.section, exactHitMisses, counts });
  const paired = intersections.filter((r) => r.delta !== null);
  const nearby = paired.filter((r) => Math.abs(r.delta) <= 0.25);
  const firstIntersection = {
    pairedHits: paired.length,
    immediateHits: intersections.filter((r) => r.immediate).length,
    zeroNormals: intersections.filter((r) => r.normalLength !== null && r.normalLength < 1e-6)
      .length,
    longitudinalErrors: [0.25, 0.5, 1, 5].map((meters) => ({
      meters,
      count: paired.filter((r) => Math.abs(r.delta) > meters).length,
    })),
    nearbyOrientation: {
      withinMeters: 0.25,
      count: nearby.length,
      dotBelowHalf: nearby.filter((r) => r.normalDot < 0.5).length,
      opposing: nearby.filter((r) => r.normalDot < 0).length,
    },
  };
  firstIntersections.push({
    section: row.section,
    summary: firstIntersection,
    rays: intersections,
  });
  rows.push({
    section: row.section,
    firstIntersection,
    policy: row.policy,
    distanceImageScale:
      row.policy === 'sampled-visibility'
        ? 'distance / world voxel size'
        : 'distance / geometric bound',
    triangles: triangles.length,
    rays: row.rays,
    counts,
    exactHits: row.exactHits,
    exactHitsCovered,
    exactHitMisses,
    expandedOnly,
    maxWorldSurfaceDistance,
    maxBandFraction,
    maxLongitudinalDifference,
    maxSteps,
    lowStepBudget,
    exhaustiveChecks,
    maxOracleDelta,
  });
}
for (const [name, pixels] of [
  ['status', states],
  ['distance', distances],
])
  await writeFile(
    resolve(output, `${name}.png`),
    Buffer.from(UPNG.encode([pixels.buffer], width, height, 0)),
  );
const median = (values) => {
  const a = values.slice().sort((a, b) => a - b);
  return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2;
};
const sumTimes = gpu.costs.map((f) => f.gpuNanoseconds.reduce((a, b) => a + b, 0) / 1e6);
const result = {
  tapeSha256: sha(tapeBytes),
  inspections,
  rows,
  failures,
  scope: manifest.scope,
  summary: {
    maxSteps: gpu.maxSteps ?? 128,
    sections: rows.length,
    rays: rows.reduce((n, r) => n + r.rays, 0),
    exactHits: rows.reduce((n, r) => n + r.exactHits, 0),
    exactHitsCovered: rows.reduce((n, r) => n + r.exactHitsCovered, 0),
    expandedOnly: rows.reduce((n, r) => n + r.expandedOnly, 0),
    stepBudget: rows.reduce((n, r) => n + r.counts.stepBudget, 0),
    exactHitMisses: rows.reduce((n, r) => n + r.exactHitMisses, 0),
    lowStepBudget: rows.reduce((n, r) => n + r.lowStepBudget, 0),
    maxBandFraction: Math.max(...rows.map((r) => r.maxBandFraction)),
    maxWorldSurfaceDistance: Math.max(...rows.map((r) => r.maxWorldSurfaceDistance)),
    samples: sumTimes.length,
    medianGpuDispatchSumMs: median(sumTimes),
    maxGpuDispatchSumMs: Math.max(...sumTimes),
    medianRecordMs: median(gpu.costs.map((f) => f.recordMs)),
    medianCompletionMs: median(gpu.costs.map((f) => f.completionMs)),
  },
  limitations:
    'Sampled visibility has no geometric error bound; its distance image is normalized by world voxel size. Geometric surface proximity band is not longitudinal intersection accuracy. Unsigned field expansion can occlude rays that miss real triangles. Isolated source geometries, no MASK opacity, inter-instance occlusion, cache lookup or GI performance qualification. GPU sum covers dispatches only, not queue gaps or frame FPS.',
};
await writeFile(
  resolve(output, 'first-intersections.json'),
  JSON.stringify(
    {
      tapeSha256: sha(tapeBytes),
      scope:
        'Actual GPU first hits versus exact geometry. Nearby normals require longitudinal agreement; these diagnostics do not qualify material identity or GI.',
      rows: firstIntersections,
    },
    null,
    2,
  ),
);
await writeFile(resolve(output, 'report.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ summary: result.summary, failures }, null, 2));
assert.equal(failures.length, 0);
assert(result.summary.lowStepBudget > 0, 'one-step falsifier must expose exhaustion');
