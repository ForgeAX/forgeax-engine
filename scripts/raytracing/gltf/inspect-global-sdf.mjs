import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  decodeMeshDistanceField,
  distanceFieldTexel,
  sampleMeshDistanceField,
} from '../../../packages/geometry/dist/index.mjs';
import { mat4 } from '../../../packages/math/dist/index.mjs';
import { packSdfScene } from '../../../packages/render/src/raytracing/sdf-query.ts';
import { buildFrameModel, decodeTape } from '../../../packages/rhi-debug/dist/index.mjs';
import { sdfStorageCode } from './sdf-storage.mjs';

const input = resolve(process.argv[2]),
  output = resolve(process.argv[3]);
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const manifest = await json(resolve(input, 'composition.json')),
  gpu = await json(resolve(output, 'gpu.json'));
const tapeBytes = new Uint8Array(await readFile(resolve(output, 'global-compose.rhitape')));
const tape = decodeTape(tapeBytes).unwrap(),
  model = buildFrameModel(tape),
  fields = new Map(),
  rows = [];
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
assert.deepEqual(gpu.gpuErrors, []);
assert.deepEqual(gpu.errors, []);
assert.deepEqual(model.unseededResources, []);
assert.equal(
  model.works.length,
  manifest.cases.reduce((n, row) => n + (row.queryFile ? 2 : 1), 0),
);
for (const row of manifest.cases) {
  const i = gpu.works.findIndex((work) => work.section === row.name);
  assert(i >= 0);
  const work = model.works[i],
    grid = row.grid,
    dims = grid.dimensions,
    count = dims.reduce((n, v) => n * v, 1);
  assert.equal(gpu.works[i].differentBytes, 0);
  assert.deepEqual(
    work.bindings.map((b) => b.binding),
    [0, 1, 2, 3, 4],
  );
  assert.equal(work.drawCall.x, Math.ceil(count / 64));
  const seeds = work.bindings.map((b) => tape.bootstrap.find((r) => r.handleId === b.resourceId));
  assert(seeds.every((s) => s?.initialData.length === 1));
  const bytesOf = (seed) => tape.blobs.find((b) => b.hash === seed.initialData[0].hash).bytes;
  const settingsBytes = bytesOf(seeds[3]);
  const settings = new DataView(
    settingsBytes.buffer,
    settingsBytes.byteOffset,
    settingsBytes.byteLength,
  );
  assert.deepEqual(
    [0, 1, 2].map((a) => settings.getFloat32(a * 4, true)),
    grid.origin.map(Math.fround),
  );
  assert.equal(settings.getFloat32(12, true), Math.fround(grid.spacing));
  assert.deepEqual(
    [0, 1, 2, 3].map((a) => settings.getUint32(16 + a * 4, true)),
    [...dims, row.sources.length],
  );
  assert.equal(seeds[4].initialData[0].hash, sha(new Uint8Array(count * 16)));
  assert.equal(work.pipeline.status, 'available');
  const sources = [];
  for (const source of row.sources) {
    let field = source.field;
    if (source.fieldFile) {
      if (!fields.has(source.fieldFile))
        fields.set(
          source.fieldFile,
          (
            await decodeMeshDistanceField(
              new Uint8Array(await readFile(resolve(input, source.fieldFile))),
              source.meshDigest,
            )
          ).unwrap(),
        );
      field = fields.get(source.fieldFile);
    }
    const t = Array.from(source.transform, Math.fround);
    sources.push({
      ...source,
      field,
      inverse: mat4.invert(mat4.create(), mat4.clone(t)),
      scales: [0, 4, 8].map((a) => Math.hypot(t[a], t[a + 1], t[a + 2])),
    });
  }
  const viewOf = (seed) => {
    const bytes = bytesOf(seed);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const instances = viewOf(seeds[0]),
    bounds = viewOf(seeds[2]);
  for (const [index, source] of sources.entries()) {
    assert.deepEqual(
      [0, 1, 2, 3].map((a) => instances.getUint32(index * 144 + 64 + a * 4, true)),
      [source.instanceId, source.geometryId, 0xffffffff, source.mask],
    );
    assert.deepEqual(
      Array.from({ length: 16 }, (_, a) => instances.getFloat32(index * 144 + a * 4, true)),
      Array.from(source.inverse),
    );
    const expected = [
      ...(source.field.policy?.kind === 'sampled-visibility'
        ? source.field.policy.traceBounds
        : source.field.bounds
      ).min,
      source.field.missing
        ? 0
        : Number(
            source.field.policy.kind === 'sampled-visibility'
              ? source.field.policy.mostlyTwoSided
              : source.field.policy.kind === 'two-sided',
          ),
      ...(source.field.policy?.kind === 'sampled-visibility'
        ? source.field.policy.traceBounds
        : source.field.bounds
      ).max,
      0,
      ...source.scales,
      Math.min(...source.scales),
    ].map(Math.fround);
    assert.deepEqual(
      Array.from({ length: 12 }, (_, a) => bounds.getFloat32(index * 48 + a * 4, true)),
      expected,
    );
  }
  const packedScene = packSdfScene(sources, 1024).unwrap();
  assert.equal(seeds[0].initialData[0].hash, sha(packedScene.instances));
  assert.equal(seeds[1].initialData[0].hash, sha(packedScene.fields));
  const encodedBytes = bytesOf(seeds[1]);
  const encoded = new DataView(
    encodedBytes.buffer,
    encodedBytes.byteOffset,
    encodedBytes.byteLength,
  );
  for (const [index, source] of sources.entries()) {
    if (source.field.policy?.kind !== 'sampled-visibility') continue;
    const start = instances.getUint32(index * 144 + 80, true);
    const band = instances.getFloat32(index * 144 + 124, true);
    assert.equal(band, source.field.policy.distanceBand);
    const field = source.field,
      [nx, ny, nz] = field.dimensions;
    for (let i = 0; i < nx * ny * nz; i++) {
      const value = distanceFieldTexel(
        field,
        i % nx,
        Math.floor(i / nx) % ny,
        Math.floor(i / (nx * ny)),
      );
      const code = sdfStorageCode(encoded, start, field.dimensions, i);
      const expected = Math.max(-32767, Math.min(32767, Math.round((value / band) * 32767)));
      assert(code === expected, 'captured SDF code must equal original quantized sample');
    }
    source.field = {
      ...field,
      // CPU interpolation consumes the same quantized samples as the captured GPU field.
      values: Float32Array.from(field.values, (value) =>
        Math.fround(
          (Math.max(-32767, Math.min(32767, Math.round((value / band) * 32767))) / 32767) * band,
        ),
      ),
    };
  }

  const bytes = await readFile(resolve(output, `${row.name}.bin`));
  assert.equal(bytes.length, count * 16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const states = { complete: 0, missingField: 0, twoSided: 0, nearestKnown: 0 },
    tolerance = 1e-4;
  let maxDistanceDelta = 0,
    bandBoundarySamples = 0;
  for (let index = 0; index < count; index++) {
    const cell = [
      index % dims[0],
      Math.floor(index / dims[0]) % dims[1],
      Math.floor(index / (dims[0] * dims[1])),
    ];
    const world = cell.map((v, a) => Math.fround(grid.origin[a] + v * grid.spacing));
    let expected = grid.maxDistance,
      missing = false,
      one = false,
      two = false,
      boundary = false;
    for (const source of sources) {
      if (source.mask === 0) continue;
      const m = source.inverse,
        p = [0, 1, 2].map(
          (a) => m[a] * world[0] + m[a + 4] * world[1] + m[a + 8] * world[2] + m[a + 12],
        );
      const b =
          source.field.policy?.kind === 'sampled-visibility'
            ? source.field.policy.traceBounds
            : source.field.bounds,
        q = p.map((v, a) => Math.max(b.min[a] - v, v - b.max[a]) * source.scales[a]);
      const box = Math.hypot(...q.map((v) => Math.max(v, 0))) + Math.min(0, Math.max(...q));
      if (box >= grid.maxDistance) continue;
      if (source.field.missing) {
        missing = true;
        continue;
      }
      const sample = sampleMeshDistanceField(
        source.field,
        p.map((v, a) => Math.max(b.min[a], Math.min(v, b.max[a]))),
      );
      assert.notEqual(sample, null);
      const distance = Math.max(sample * Math.min(...source.scales) + Math.max(box, 0), box);
      expected = Math.min(expected, distance);
      if (Math.abs(Math.abs(distance) - grid.coverageDistance) < tolerance) boundary = true;
      if (Math.abs(distance) < grid.coverageDistance) {
        if (
          source.field.policy.kind === 'sampled-visibility'
            ? source.field.policy.mostlyTwoSided
            : source.field.policy.kind === 'two-sided'
        )
          two = true;
        else one = true;
      }
    }
    expected = Math.max(-grid.maxDistance, expected);
    const distance = view.getFloat32(index * 16, true),
      coverage = view.getFloat32(index * 16 + 4, true),
      status = view.getUint32(index * 16 + 8, true),
      nearest = view.getUint32(index * 16 + 12, true);
    assert(Number.isFinite(distance));
    assert([0, 1].includes(coverage));
    assert.equal(status, missing ? 2 : 1, `${row.name} missing at ${index}`);
    const delta = Math.abs(distance - expected);
    maxDistanceDelta = Math.max(maxDistanceDelta, delta);
    assert(delta < tolerance, `${row.name} distance ${index}: ${distance} vs ${expected}`);
    if (boundary) bandBoundarySamples++;
    else assert.equal(coverage, two && !one ? 0 : 1);
    if (nearest !== 0xffffffff) {
      assert(sources.some((s) => s.instanceId === nearest && s.mask && !s.field.missing));
      states.nearestKnown++;
    }
    states[missing ? 'missingField' : 'complete']++;
    if (coverage === 0) states.twoSided++;
  }
  rows.push({
    name: row.name,
    count,
    states,
    maxDistanceDelta,
    tolerance,
    bandBoundarySamples,
    workIndex: work.workIndex,
    eventIndex: work.eventIndex,
    bindings: work.bindings.map((b, k) => ({ ...b, initialData: seeds[k].initialData })),
    shaderSha256: sha(work.pipeline.shaders[0].source),
    outputSha256: sha(bytes),
  });
}
const totals = gpu.costs
  .map((s) => s.gpuNanoseconds.reduce((n, v) => n + v, 0) / 1e6)
  .sort((a, b) => a - b);
const report = {
  tapeSha256: sha(tapeBytes),
  rows,
  cost: {
    scope: 'All recorded composition and optional query works; per-work samples are in gpu.json.',
    samples: totals.length,
    warmup: gpu.warmup,
    medianMs: totals[Math.floor(totals.length / 2)],
    maxMs: totals.at(-1),
    recorder: false,
  },
  scope: manifest.scope,
};
await writeFile(resolve(output, 'inspection.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    tape: report.tapeSha256,
    rows: rows.map(({ name, count, states, maxDistanceDelta }) => ({
      name,
      count,
      states,
      maxDistanceDelta,
    })),
    cost: report.cost,
  }),
);
