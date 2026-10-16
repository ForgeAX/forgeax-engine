import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';

const directory = resolve(process.argv[2] ?? 'artifacts/ray-sponza');
const bytes = await readFile(resolve(directory, 'sponza.rhitape'));
const tape = decodeTape(bytes).unwrap(),
  model = buildFrameModel(tape);
const prepared = JSON.parse(await readFile(resolve(directory, 'prepared.json'), 'utf8'));
const triangles = await readFile(resolve(directory, 'triangles.bin'));
const triangle = new DataView(triangles.buffer, triangles.byteOffset, triangles.byteLength);
const first = (entry) => {
  const work = model.works.find((w) => w.pipeline.shaders.some((s) => s.entryPoint === entry));
  assert(work, `Missing stage ${entry}`);
  return work;
};
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: create([]) }, configurable: true });
const device = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
const errors = [];
gpu
  ._internal_getRawDevice(device)
  .addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const replay = (
  await openReplay(tape, { device, createShaderModule: gpu.createShaderModule })
).unwrap();
const read = async (entry, binding) => {
  const work = first(entry),
    resourceId = work.bindings.find((b) => b.binding === binding)?.resourceId;
  assert(resourceId);
  const raw = (await replay.readResourceAtWork(resourceId, work.workIndex)).unwrap().bytes.slice();
  await writeFile(resolve(directory, `stage-${entry}-binding-${binding}.bin`), raw);
  return {
    workIndex: work.workIndex,
    resourceId,
    f: new Float32Array(raw.buffer),
    u: new Uint32Array(raw.buffer),
  };
};
const checks = [],
  failures = [];
const check = (condition, gate, pixel) => {
  if (!condition && failures.length < 20) failures.push({ gate, pixel });
};
try {
  const rays = await read('generate', 3);
  const count = rays.f.length / 20;
  for (let i = 0; i < count; i++) {
    check(
      Math.abs(Math.hypot(...rays.f.subarray(i * 20 + 4, i * 20 + 7)) - 1) < 1e-5,
      'unit-ray',
      i,
    );
    check(rays.u[i * 20 + 16] === 1 && rays.u[i * 20 + 17] === 0, 'primary-ray-state', i);
  }
  checks.push({
    gate: 'ray-generation',
    workIndex: rays.workIndex,
    resourceId: rays.resourceId,
    count,
  });
  const inputs = await read('sealCoverage', 4),
    surfaces = await read('sealCoverage', 5);
  let hits = 0,
    misses = 0,
    opposedNormals = 0;
  for (let i = 0; i < count; i++) {
    if (inputs.u[i * 56 + 53] === 0) {
      misses++;
      continue;
    }
    hits++;
    const ordered = inputs.u[i * 56 + 55];
    check(ordered < prepared.scene.triangleCount, 'triangle-index', i);
    check(
      triangle.getUint32(ordered * 80 + 60, true) === inputs.u[i * 56 + 52],
      'material-identity',
      i,
    );
    for (let c = 0; c < 3; c++) {
      const expected = rays.f[i * 20 + c] + rays.f[i * 20 + 4 + c] * inputs.f[i * 56 + 7];
      check(
        Math.abs(expected - inputs.f[i * 56 + 4 + c]) < 1e-4 * Math.max(1, Math.abs(expected)),
        'hit-position',
        i,
      );
    }
    check(surfaces.u[i * 24 + 16] === 1, 'covered-valid-surface', i);
    check(
      Math.abs(Math.hypot(...surfaces.f.subarray(i * 24 + 4, i * 24 + 7)) - 1) < 1e-4,
      'unit-shading-normal',
      i,
    );
    let dot = 0;
    for (let c = 0; c < 3; c++) dot += surfaces.f[i * 24 + 4 + c] * surfaces.f[i * 24 + 20 + c];
    if (dot <= 0) opposedNormals++;
  }
  checks.push({
    gate: 'candidate-and-material',
    workIndex: inputs.workIndex,
    inputs: inputs.resourceId,
    surfaces: surfaces.resourceId,
    hits,
    misses,
    opposedNormals,
  });
  const before = await read('beginShadow', 3),
    after = await read('endShadow', 3),
    query = await read('endShadow', 9);
  let clear = 0,
    blockedOrSkipped = 0;
  for (let i = 0; i < count; i++) {
    const state = query.u[i * 96 + 92];
    check(state === 1 || state === 2, 'shadow-complete', i);
    if (state === 2) clear++;
    else blockedOrSkipped++;
    for (let c = 0; c < 3; c++) {
      const expected = state === 2 ? before.f[i * 20 + 8 + c] * query.f[i * 96 + 88 + c] : 0;
      check(
        Math.abs(after.f[i * 20 + 12 + c] - before.f[i * 20 + 12 + c] - expected) < 1e-5,
        'shadow-contribution',
        i,
      );
    }
  }
  checks.push({
    gate: 'analytic-shadow-contribution',
    beforeWork: before.workIndex,
    afterWork: after.workIndex,
    resourceId: query.resourceId,
    clear,
    blockedOrSkipped,
  });
  const accumulated = await read('accumulate', 6);
  for (let i = 0; i < count; i++) {
    check(accumulated.u[i * 20 + 7] === 0, 'sample-error', i);
    if (inputs.u[i * 56 + 53] === 0) {
      for (let c = 0; c < 4; c++)
        check(accumulated.u[i * 20 + 16 + c] === 0xffffffff, 'miss-identity', i);
    } else {
      const ordered = inputs.u[i * 56 + 55];
      for (let c = 0; c < 4; c++)
        check(
          accumulated.u[i * 20 + 16 + c] === triangle.getUint32(ordered * 80 + 48 + c * 4, true),
          'covered-hit-identity',
          i,
        );
    }
  }
  checks.push({
    gate: 'primary-aov',
    workIndex: accumulated.workIndex,
    resourceId: accumulated.resourceId,
  });
  const report = {
    scope:
      'Reference query/material stage gates; not raster-direct or integrated Sponza GI acceptance',
    checks,
    failures,
    errors,
  };
  await writeFile(resolve(directory, 'stages.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
} finally {
  (await replay.dispose()).unwrap();
  gpu._internal_getRawDevice(device).destroy();
  delete globalThis.navigator;
}
