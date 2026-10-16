import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeMeshDistanceField } from '../../../packages/geometry/dist/index.mjs';
import { packReferenceRays } from '../../../packages/render/src/raytracing/scene.ts';
import { packSdfScene } from '../../../packages/render/src/raytracing/sdf-query.ts';
import { buildFrameModel, decodeTape } from '../../../packages/rhi-debug/dist/index.mjs';

const input = resolve(process.argv[2]),
  output = resolve(process.argv[3]);
const reportOption = process.argv.indexOf('--report');
const reportArgument = reportOption < 0 ? null : process.argv[reportOption + 1];
assert(
  reportOption < 0 || (reportArgument && !reportArgument.startsWith('--')),
  '--report requires a path',
);
const reportPath = reportArgument
  ? resolve(reportArgument)
  : resolve(output, 'software-query-inspection.json');
const load = async (name, root = input) => new Uint8Array(await readFile(resolve(root, name)));
const json = async (name, root = input) =>
  JSON.parse(new TextDecoder().decode(await load(name, root)));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const gpu = await json('gpu.json', output),
  manifest = await json('composition.json');
const tapeBytes = await load('global-compose.rhitape', output),
  tape = decodeTape(tapeBytes).unwrap(),
  model = buildFrameModel(tape);
assert.deepEqual(gpu.errors, []);
assert.deepEqual(gpu.gpuErrors, []);
assert.deepEqual(model.unseededResources, []);
assert.equal(
  model.works.length,
  manifest.cases.reduce((n, c) => n + (c.queryFile ? 4 : 1), 0),
);
const fields = new Map(),
  rows = [];
const seed = (work, binding) => {
  const resourceId = work.bindings.find((b) => b.binding === binding).resourceId;
  const initial = tape.bootstrap.find((r) => r.handleId === resourceId);
  assert.equal(initial.initialData.length, 1);
  return tape.blobs.find((b) => b.hash === initial.initialData[0].hash).bytes;
};
for (const c of manifest.cases) {
  if (!c.queryFile) continue;
  const start = gpu.works.findIndex((w) => w.section === c.name);
  assert(start >= 0);
  const [compose, detail, gate, global] = model.works.slice(start, start + 4);
  for (const [i, name] of [
    c.name,
    `${c.name}-detail`,
    `${c.name}-continuation`,
    `${c.name}-query`,
  ].entries()) {
    assert.equal(gpu.works[start + i].section, name);
    assert.equal(gpu.works[start + i].differentBytes, 0);
  }
  assert.equal(detail.bindings[2].resourceId, gate.bindings[0].resourceId);
  assert.equal(detail.bindings[3].resourceId, gate.bindings[1].resourceId);
  assert.equal(gate.bindings[2].resourceId, global.bindings[2].resourceId);
  assert.equal(compose.bindings[4].resourceId, global.bindings[0].resourceId);
  assert.equal(compose.bindings[3].resourceId, global.bindings[1].resourceId);
  const sources = [];
  for (const source of c.sources) {
    let field = source.field;
    if (source.fieldFile) {
      if (!fields.has(source.fieldFile)) {
        const bytes = await load(source.fieldFile);
        assert.equal(sha(bytes), manifest.fields[source.fieldFile].sha256);
        fields.set(
          source.fieldFile,
          (await decodeMeshDistanceField(bytes, source.meshDigest)).unwrap(),
        );
      }
      field = fields.get(source.fieldFile);
    }
    sources.push({ ...source, field });
  }
  const packed = packSdfScene(sources).unwrap();
  for (const work of [compose, detail]) {
    assert.equal(sha(seed(work, 0)), sha(packed.instances));
    assert.equal(sha(seed(work, 1)), sha(packed.fields));
  }
  assert.deepEqual(Array.from(new Uint32Array(seed(detail, 4).slice().buffer)), [
    sources.length,
    128,
    process.argv.includes('--ray-distance') ? 1 : 0,
    0,
  ]);
  const settings = view(seed(global, 4));
  assert.equal(settings.getUint32(0, true), 256);
  assert.equal(settings.getFloat32(4, true), 1);
  const cohortBytes = await load(c.queryFile);
  assert.equal(sha(cohortBytes), manifest.cohorts[c.queryFile].sha256);
  const { rays, exact } = JSON.parse(new TextDecoder().decode(cohortBytes));
  const original = packReferenceRays(rays).unwrap(),
    ov = view(original),
    near = seed(detail, 2),
    nv = view(near);
  assert.equal(sha(seed(global, 2)), sha(original));
  assert.equal(near.length, original.length);
  assert.equal(sha(seed(detail, 3)), sha(new Uint8Array(rays.length * 64)));
  assert.equal(sha(seed(global, 3)), sha(new Uint8Array(rays.length * 64)));
  const localBytes = await load(`${c.name}-detail.bin`, output),
    nextBytes = await load(`${c.name}-continuation.bin`, output),
    farBytes = await load(`${c.name}-query.bin`, output);
  const local = view(localBytes),
    next = view(nextBytes),
    far = view(farBytes);
  assert.equal(localBytes.length, rays.length * 64);
  assert.equal(farBytes.length, localBytes.length);
  assert.equal(nextBytes.length, original.length);
  const expected = original.slice(),
    ev = view(expected),
    detailStates = {},
    globalStates = {},
    perRay = [];
  const detailNames = [
    'miss',
    'surfaceBand',
    'insideStart',
    'stepBudget',
    'missingField',
    'visibilityHit',
  ];
  const globalNames = [
    'miss',
    'hit',
    'negativeStart',
    'stepBudget',
    'missingField',
    'outsideRegion',
  ];
  let continued = 0,
    detailInsideHeuristic = 0,
    nearMissWithEarlierGeometry = 0;
  const errors = [];
  for (let i = 0; i < rays.length; i++) {
    const r = i * 48,
      h = i * 64;
    for (const offset of [0, 4, 8, 12, 16, 20, 24, 32, 36, 40, 44])
      assert.equal(nv.getUint32(r + offset, true), ov.getUint32(r + offset, true));
    const end = Math.min(
      ov.getFloat32(r + 28, true),
      Math.fround(
        ov.getFloat32(r + 12, true) +
          gpu.detailDistance / Math.hypot(...[16, 20, 24].map((o) => ov.getFloat32(r + o, true))),
      ),
    );
    assert.equal(nv.getFloat32(r + 28, true), end);
    const nearState = local.getUint32(h, true),
      farState = far.getUint32(h, true);
    assert(nearState < detailNames.length && farState < globalNames.length);
    detailStates[detailNames[nearState]] = (detailStates[detailNames[nearState]] ?? 0) + 1;
    if (nearState === 0)
      assert.deepEqual(
        [4, 8, 12].map((o) => local.getUint32(h + o, true)),
        [0xffffffff, 0xffffffff, 0xffffffff],
      );
    const enabled =
      ov.getUint32(r + 32, true) !== 0 && nearState === 0 && end < ov.getFloat32(r + 28, true);
    if (enabled) {
      ev.setFloat32(r + 12, end, true);
      continued++;
      globalStates[globalNames[farState]] = (globalStates[globalNames[farState]] ?? 0) + 1;
    } else {
      ev.setUint32(r + 32, 0, true);
      assert.equal(farState, 0);
      assert.equal(far.getUint32(h + 8, true), 0);
    }
    const negative = nearState === 2 || (nearState === 5 && local.getFloat32(h + 28, true) > 0);
    if (negative) detailInsideHeuristic++;
    const eligibleHit = enabled
      ? farState === 1
      : !negative && (nearState === 1 || nearState === 5);
    const t = (enabled ? far : local).getFloat32(h + 16, true);
    assert(Number.isFinite(t));
    const reference = rays[i].mask && c.sources.some((s) => s.mask) ? (exact[i] ?? null) : null;
    const nearMissBeforeGeometry = enabled && reference !== null && reference < end;
    if (nearMissBeforeGeometry) nearMissWithEarlierGeometry++;
    const error =
      eligibleHit && reference !== null
        ? Math.abs(t - reference) * Math.hypot(...rays[i].direction)
        : null;
    if (error !== null) errors.push(error);
    perRay.push({
      index: i,
      route: rays[i].mask === 0 ? 'disabled' : enabled ? 'global' : 'detail',
      detail: detailNames[nearState],
      detailNegative: negative,
      detailEnd: end,
      nearMissBeforeGeometry,
      global: enabled ? globalNames[farState] : null,
      t,
      exact: reference,
      error,
    });
  }
  if (process.argv.includes('--falsify-continuation') && rows.length === 0)
    next.setFloat32(12, next.getFloat32(12, true) + 0.1, true);
  assert.deepEqual(
    nextBytes,
    expected,
    'continuation bytes must follow executed detail state and preserve the full interval',
  );
  errors.sort((a, b) => a - b);
  const costs = gpu.costs.map((s) => s.gpuNanoseconds.slice(start, start + 4).map((v) => v / 1e6));
  rows.push({
    name: c.name,
    rays: rays.length,
    continued,
    detailStates,
    globalStates,
    detailInsideHeuristic,
    quality: {
      comparableHits: errors.length,
      nearMissWithEarlierGeometry,
      medianError: errors[Math.floor(errors.length / 2)] ?? null,
      over1m: errors.filter((e) => e > 1).length,
    },
    workIndices: [compose.workIndex, detail.workIndex, gate.workIndex, global.workIndex],
    eventIndices: [compose.eventIndex, detail.eventIndex, gate.eventIndex, global.eventIndex],
    cohortSha256: sha(cohortBytes),
    detailSha256: sha(localBytes),
    continuationSha256: sha(nextBytes),
    globalSha256: sha(farBytes),
    costsMs: costs,
    perRay,
  });
}
const result = {
  tapeSha256: sha(tapeBytes),
  scope:
    'Frozen complete-roster GPU continuation; approximate near misses are not exact geometry clearance. Disabled Global results must never be counted as final scene misses. Negative, missing and exhausted detail results remain terminal. No GI/material qualification.',
  rows,
};
await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify(
    rows.map(({ perRay, costsMs, ...r }) => r),
    null,
    2,
  ),
);
