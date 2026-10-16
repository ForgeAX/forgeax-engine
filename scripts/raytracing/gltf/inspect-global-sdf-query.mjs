import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packReferenceRays } from '../../../packages/render/src/raytracing/scene.ts';
import { buildFrameModel, decodeTape } from '../../../packages/rhi-debug/dist/index.mjs';

const input = resolve(process.argv[2]),
  output = resolve(process.argv[3]);
const json = async (name, root = input) => JSON.parse(await readFile(resolve(root, name), 'utf8'));
const manifest = await json('composition.json'),
  gpu = await json('gpu.json', output);
const bytes = new Uint8Array(await readFile(resolve(output, 'global-compose.rhitape')));
const tape = decodeTape(bytes).unwrap(),
  model = buildFrameModel(tape);
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const names = ['miss', 'hit', 'negativeStart', 'stepBudget', 'missingField', 'outsideRegion'];
assert.deepEqual(gpu.errors, []);
assert.deepEqual(gpu.gpuErrors, []);
assert.deepEqual(model.unseededResources, []);
assert.equal(gpu.noWorkNonzeroBytes, 0);
const rows = [];
for (const row of manifest.cases) {
  if (!row.queryFile) continue;
  const queryBytes = await readFile(resolve(input, row.queryFile));
  assert.equal(sha(queryBytes), `sha256:${manifest.cohorts[row.queryFile].sha256}`);
  const cohort = JSON.parse(queryBytes),
    { rays, exact } = cohort;
  const index = gpu.works.findIndex((w) => w.section === `${row.name}-query`);
  assert(index > 0);
  assert.equal(gpu.works[index].differentBytes, 0);
  const work = model.works[index],
    composition = model.works[index - 1];
  assert.equal(work.pipeline.status, 'available');
  assert.deepEqual(
    work.bindings.map((b) => b.binding),
    [0, 1, 2, 3, 4],
  );
  assert.equal(work.drawCall.x, Math.ceil(rays.length / 64));
  assert.equal(work.bindings[0].resourceId, composition.bindings[4].resourceId);
  assert.equal(work.bindings[1].resourceId, composition.bindings[3].resourceId);
  const initial = (binding) => {
    const seed = tape.bootstrap.find((r) => r.handleId === work.bindings[binding].resourceId);
    assert.equal(seed.initialData.length, 1);
    return tape.blobs.find((b) => b.hash === seed.initialData[0].hash).bytes;
  };
  assert.equal(sha(initial(2)), sha(packReferenceRays(rays).unwrap()));
  assert.equal(sha(initial(3)), sha(new Uint8Array(rays.length * 64)));
  const querySettings = view(initial(4));
  assert.equal(querySettings.getUint32(0, true), 256);
  assert.equal(querySettings.getFloat32(4, true), Math.fround(gpu.minStepFactor ?? 1));
  assert.equal(querySettings.getUint32(8, true), 0);
  assert.equal(querySettings.getUint32(12, true), 0);
  const values = await readFile(resolve(output, `${row.name}-query.bin`)),
    data = view(values);
  assert.equal(values.length, rays.length * 64);
  const gridData = view(await readFile(resolve(output, `${row.name}.bin`)));
  const { grid } = row,
    dims = grid.dimensions;
  const sample = (p) => {
    const q = p.map((v, a) =>
      Math.max(0, Math.min(dims[a] - 1, (v - grid.origin[a]) / grid.spacing)),
    );
    const cell = q.map((v, a) => Math.min(Math.floor(v), dims[a] - 2));
    const f = q.map((v, a) => v - cell[a]);
    let distance = 0;
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          const weight = [x, y, z].reduce((w, v, a) => w * (v ? f[a] : 1 - f[a]), 1);
          if (!weight) continue;
          const offset = (((cell[2] + z) * dims[1] + cell[1] + y) * dims[0] + cell[0] + x) * 16;
          if (gridData.getUint32(offset + 8, true) !== 1) return null;
          distance += gridData.getFloat32(offset, true) * weight;
        }
    return distance;
  };
  const stats = Object.fromEntries(names.map((name) => [name, 0]));
  const quality = {
    exactHits: 0,
    comparableHits: 0,
    uncoveredExactHits: 0,
    errorsOver1m: 0,
    extraHits: 0,
    negativeStarts: 0,
    zeroNormals: 0,
    maxFirstSampleDelta: 0,
  };
  const errors = [],
    perRay = [];
  for (const [i, ray] of rays.entries()) {
    const offset = i * 64,
      status = data.getUint32(offset, true),
      t = data.getFloat32(offset + 16, true);
    assert(status < names.length);
    stats[names[status]]++;
    const metrics = Array.from({ length: 4 }, (_, a) => data.getFloat32(offset + 16 + a * 4, true));
    const position = Array.from({ length: 3 }, (_, a) =>
      data.getFloat32(offset + 32 + a * 4, true),
    );
    const normal = Array.from({ length: 3 }, (_, a) => data.getFloat32(offset + 48 + a * 4, true));
    assert([...metrics, ...position, ...normal].every(Number.isFinite));
    assert(t >= Math.fround(ray.tMin) && t <= Math.fround(ray.tMax));
    assert(data.getUint32(offset + 8, true) <= 256);
    if (status !== 1) assert.deepEqual(normal, [0, 0, 0]);
    else if (Math.hypot(...normal) < 1e-5) quality.zeroNormals++;
    else assert(Math.abs(Math.hypot(...normal) - 1) < 1e-4);
    if (status === 2) {
      assert(metrics[2] < 0);
      quality.negativeStarts++;
    }
    if (ray.mask && data.getUint32(offset + 8, true) > 0 && status !== 4) {
      const first = sample(
        ray.origin.map((v, a) =>
          Math.fround(
            Math.fround(v) + Math.fround(Math.fround(ray.direction[a]) * Math.fround(ray.tMin)),
          ),
        ),
      );
      assert(first !== null);
      quality.maxFirstSampleDelta = Math.max(
        quality.maxFirstSampleDelta,
        Math.abs(first - metrics[2]),
      );
    }
    const expected = row.sources.some((s) => s.mask) && ray.mask ? (exact[i] ?? null) : null;
    if (expected !== null) {
      quality.exactHits++;
      if (status === 1) {
        const error = Math.abs(t - expected) * Math.hypot(...ray.direction);
        errors.push(error);
        quality.comparableHits++;
        if (error > 1) quality.errorsOver1m++;
      } else quality.uncoveredExactHits++;
    } else if (status === 1) quality.extraHits++;
    perRay.push({
      index: i,
      status: names[status],
      t,
      exact: expected,
      steps: data.getUint32(offset + 8, true),
      firstDistance: metrics[2],
      expansion: metrics[1],
    });
  }
  assert(quality.maxFirstSampleDelta < 1e-4);
  errors.sort((a, b) => a - b);
  const costs = gpu.costs.map((s) => s.gpuNanoseconds[index] / 1e6).sort((a, b) => a - b);
  rows.push({
    name: row.name,
    workIndex: index,
    eventIndex: work.eventIndex,
    rays: rays.length,
    stats,
    quality,
    commonHitMedianError: errors[Math.floor(errors.length / 2)] ?? null,
    maxError: errors.at(-1) ?? null,
    gpuMs: {
      samples: costs.length,
      median: costs[Math.floor(costs.length / 2)],
      p95: costs[Math.ceil(costs.length * 0.95) - 1],
      max: costs.at(-1),
    },
    inputSha256: sha(queryBytes),
    outputSha256: sha(values),
    shaderSha256: sha(work.pipeline.shaders[0].source),
    perRay,
  });
}
const result = {
  scope:
    'Execution and provenance checks only; raw geometry discrepancies do not imply material opacity or GI acceptance.',
  tapeSha256: sha(bytes),
  rows,
};
await writeFile(resolve(output, 'query-inspection.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    rows.map(({ perRay, ...row }) => row),
    null,
    2,
  ),
);
