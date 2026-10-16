import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distanceFieldMeshDigest } from '../../../packages/geometry/src/distance-field.ts';
import {
  createTriangleQuery,
  triangleDistanceSquared,
} from '../../../packages/geometry/src/triangle-query.ts';
import { buildFrameModel, decodeTape } from '../../../packages/rhi-debug/dist/index.mjs';

const [input, clearance, rayDistance, p] = process.argv.slice(2);
assert(
  input && clearance && rayDistance && p,
  'usage: inspect-thin-gap-sdf <input> <clearance-capture> <ray-distance-capture> <output>',
);
await mkdir(p, { recursive: true });
const inspector = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'inspect-software-sdf-query.mjs',
);
for (const [capture, policy, flags] of [
  [clearance, 'clearance', []],
  [rayDistance, 'ray-distance', ['--ray-distance']],
])
  execFileSync(
    process.execPath,
    [inspector, input, capture, ...flags, '--report', resolve(p, `${policy}-inspection.json`)],
    { stdio: 'inherit' },
  );
const captures = { clearance: clearance, 'ray-distance': rayDistance };
const json = async (f) => JSON.parse(await readFile(f)),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const source = await json(resolve(input, 'source.json')),
  manifest = await json(resolve(input, 'composition.json'));
const tapes = [];
for (const policy of ['clearance', 'ray-distance']) {
  const bytes = new Uint8Array(await readFile(`${captures[policy]}/global-compose.rhitape`));
  const tape = decodeTape(bytes).unwrap();
  tapes.push({
    policy,
    tape,
    model: buildFrameModel(tape),
    sha256: sha(bytes),
    inspection: await json(resolve(p, `${policy}-inspection.json`)),
  });
}
const seed = (t, w, b) => {
  const id = w.bindings.find((x) => x.binding === b).resourceId;
  const r = t.bootstrap.find((x) => x.handleId === id);
  assert.equal(r.initialData.length, 1);
  return t.blobs.find((x) => x.hash === r.initialData[0].hash).bytes;
};
const [a, b] = tapes;
assert.equal(a.model.works.length, b.model.works.length);
for (let i = 0; i < a.model.works.length; i++) {
  const x = a.model.works[i],
    y = b.model.works[i];
  assert(
    x.pipeline.shaders.length > 0 && x.pipeline.shaders.every((s) => typeof s.source === 'string'),
  );
  assert.deepEqual(
    x.pipeline.shaders.map(({ stage, source, entryPoint }) => ({ stage, source, entryPoint })),
    y.pipeline.shaders.map(({ stage, source, entryPoint }) => ({ stage, source, entryPoint })),
  );
  assert.equal(x.bindings.length, y.bindings.length);
  for (const binding of x.bindings) {
    const old = seed(a.tape, x, binding.binding),
      next = seed(b.tape, y, binding.binding);
    if (i % 4 === 1 && binding.binding === 4) {
      const v = new Uint32Array(old.slice().buffer),
        z = new Uint32Array(next.slice().buffer);
      assert.equal(v[2], 0);
      assert.equal(z[2], 1);
      v[2] = 1;
      assert.deepEqual(v, z);
    } else assert.equal(sha(old), sha(next));
  }
}
const distribution = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return {
    count: v.length,
    min: v[0] ?? null,
    median: v[Math.floor(v.length / 2)] ?? null,
    p95: v[Math.floor(v.length * 0.95)] ?? null,
    max: v.at(-1) ?? null,
  };
};
const rows = [];
for (const c of manifest.cases) {
  assert.equal(c.sources.length, 1, 'thin-gap fixture has one complete mesh per case');
  const cohort = await json(`${input}/${c.queryFile}`),
    scene = source.scenes.find((s) => s.fieldFile === c.sources[0].fieldFile);
  assert(scene, 'captured source must have a geometric scene');
  assert.equal(cohort.rays.length, cohort.width * cohort.height);
  assert.equal(cohort.reference.length, cohort.rays.length);
  assert.equal(scene.meshDigest, c.sources[0].meshDigest);
  assert.equal(await distanceFieldMeshDigest(scene.positions, scene.indices), scene.meshDigest);
  assert.equal(
    sha(await readFile(`${clearance}/${c.name}.bin`)),
    sha(await readFile(`${rayDistance}/${c.name}.bin`)),
  );
  const triangles = [];
  for (let t = 0; t < scene.indices.length; t += 3)
    triangles.push(
      [0, 1, 2].map((k) =>
        scene.positions.slice(scene.indices[t + k] * 3, scene.indices[t + k] * 3 + 3),
      ),
    );
  const oracle = createTriangleQuery(triangles);
  for (const [i, ray] of cohort.rays.entries()) {
    const hit = { primitive: -1, distance: 0, frontFace: false };
    assert.equal(oracle.trace(hit, ray.origin, ray.direction, ray.tMin, ray.tMax), true);
    assert(
      Math.abs(hit.distance - cohort.exact[i]) < 1e-9,
      'reference distance must match source geometry',
    );
    assert.equal(
      cohort.reference[i].surface,
      scene.labels[hit.primitive],
      'reference surface must match source geometry',
    );
  }
  for (const record of tapes) {
    const inspected = record.inspection.rows.find((x) => x.name === c.name);
    const hits = {};
    for (const kind of ['detail', 'query']) {
      const bytes = await readFile(`${captures[record.policy]}/${c.name}-${kind}.bin`);
      hits[kind] = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    const perRay = [];
    for (const r of inspected.perRay) {
      const reference = cohort.reference[r.index],
        ray = cohort.rays[r.index];
      const eligible =
        !r.detailNegative &&
        (r.route === 'global' ? r.global === 'hit' : r.detail === 'visibilityHit');
      let distances = null,
        position = null,
        closest = null,
        normalLength = null;
      if (eligible) {
        const view = hits[r.route === 'global' ? 'query' : 'detail'],
          o = r.index * 64;
        position = [32, 36, 40].map((k) => view.getFloat32(o + k, true));
        assert(
          position.every((v, k) => Math.abs(v - (ray.origin[k] + ray.direction[k] * r.t)) < 1e-5),
          'captured position must reconstruct from the original ray and hit distance',
        );
        distances = { receiver: Infinity, blocker: Infinity, back: Infinity };
        for (let i = 0; i < triangles.length; i++)
          distances[scene.labels[i]] = Math.min(
            distances[scene.labels[i]],
            Math.sqrt(triangleDistanceSquared(position, triangles[i])),
          );
        const sorted = Object.entries(distances).sort((a, b) => a[1] - b[1]);
        closest = sorted[1][1] - sorted[0][1] < 1e-6 ? 'ambiguous' : sorted[0][0];
        normalLength = Math.hypot(...[48, 52, 56].map((k) => view.getFloat32(o + k, true)));
      }
      perRay.push({
        ...r,
        reference: reference.surface,
        eligible,
        position,
        distances,
        closest,
        normalLength,
        blockedOpenGap:
          eligible &&
          reference.surface === 'back' &&
          position[2] < Math.fround(scene.wallZ) + 0.001,
        missedBlocker: r.nearMissBeforeGeometry && reference.surface === 'blocker',
      });
    }
    const n = (f) => perRay.filter(f).length;
    rows.push({
      name: c.name,
      policy: record.policy,
      kind: cohort.kind,
      gap: scene.gap,
      wallZ: scene.wallZ,
      voxelSize: scene.voxelSize,
      rays: cohort.rays.length,
      exactBlocker: n((r) => r.reference === 'blocker'),
      exactGap: n((r) => r.reference === 'back'),
      eligible: n((r) => r.eligible),
      negative: n((r) => r.detailNegative),
      nearMiss: n((r) => r.nearMissBeforeGeometry),
      missedBlocker: n((r) => r.missedBlocker),
      blockedOpenGap: n((r) => r.blockedOpenGap),
      selfSurface: n((r) => r.closest === 'receiver'),
      nearestExpected: n((r) => r.closest === r.reference),
      zeroNormal: n((r) => r.eligible && r.normalLength < 1e-6),
      nearestDistance: distribution(
        perRay.filter((r) => r.eligible).map((r) => Math.min(...Object.values(r.distances))),
      ),
      costMedianMs: [0, 1, 2, 3].map(
        (i) => distribution(inspected.costsMs.map((x) => x[i])).median,
      ),
      perRay,
    });
  }
}
const data = {
  scope:
    'Captured production results; exact triangle oracle independently checks finite analytic planes. blockedOpenGap means a known back-wall ray reports a hit no farther than 1 mm behind the foreground sheet. Nearest-surface identity is geometric, with 1 micrometre ties kept ambiguous. It is not material or GI qualification.',
  width: source.width,
  height: source.height,
  tapes: tapes.map((t) => ({ policy: t.policy, sha256: t.sha256, works: t.model.works.length })),
  onlyChangedSeed: 'local settings word 2',
  rows,
};
await writeFile(`${p}/analysis.json`, JSON.stringify(data));
const brief = { ...data, rows: rows.map(({ perRay, ...r }) => r) };
await writeFile(`${p}/summary.json`, JSON.stringify(brief, null, 2));
console.log(JSON.stringify(brief, null, 2));
