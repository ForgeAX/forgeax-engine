import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTriangleQuery } from '../../../packages/geometry/src/triangle-query.ts';
import {
  buildFrameModel,
  decodeTape,
  halfToFloat,
} from '../../../packages/rhi-debug/dist/index.mjs';

const [cardsPath, worldPath, outputPath] = process.argv.slice(2).map((p) => resolve(p));
assert(
  cardsPath && worldPath && outputPath,
  'diagnose-global-cards <cards.json> <world-input> <association-output>',
);
const read = async (dir, name) => new Uint8Array(await readFile(resolve(dir, name)));
const json = async (dir, name) => JSON.parse(new TextDecoder().decode(await read(dir, name)));
const cardBytes = await readFile(cardsPath);
const sources = JSON.parse(cardBytes).sources;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifest = await json(worldPath, 'composition.json'),
  gpu = await json(outputPath, 'gpu.json'),
  inspection = await json(outputPath, 'inspection.json');
assert.equal(inspection.status, 'passed');
assert.deepEqual(gpu.gpuErrors, []);
const tapeBytes = await read(outputPath, 'global-cards.rhitape');
assert.equal(sha(tapeBytes), inspection.tapeSha256);
assert.equal(sha(cardBytes), sha(await read(gpu.cardInput, 'cards.json')));
const tape = decodeTape(tapeBytes).unwrap(),
  model = buildFrameModel(tape);
assert.deepEqual(model.unseededResources, []);
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const initial = (w, b) => {
  const seed = tape.bootstrap.find(
    (r) => r.handleId === w.bindings.find((r) => r.binding === b).resourceId,
  );
  assert.equal(seed.initialData.length, 1);
  return view(tape.blobs.find((b) => b.hash === seed.initialData[0].hash).bytes);
};
const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0),
  sub = (a, b) => a.map((v, i) => v - b[i]);
const normalize = (v) => v.map((x) => x / Math.max(Math.hypot(...v), 1e-20));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const oct = (x, y) => {
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0)
    [x, y] = [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
  return normalize([x, y, z]);
};
const triangles = [],
  identities = [];
for (const source of sources) {
  const { instance, sections } = source;
  if (!instance.mask) continue;
  const m = instance.transform,
    world = Array.from({ length: instance.positions.length / 3 }, (_, i) =>
      [0, 1, 2].map((a) =>
        Math.fround(
          m[a] * instance.positions[i * 3] +
            m[a + 4] * instance.positions[i * 3 + 1] +
            m[a + 8] * instance.positions[i * 3 + 2] +
            m[a + 12],
        ),
      ),
    );
  for (let j = 0; j < instance.indices.length; j += 3) {
    const section = sections.find((s) => j >= s.indexOffset && j < s.indexOffset + s.indexCount);
    assert(section);
    triangles.push(instance.indices.slice(j, j + 3).map((i) => world[i]));
    identities.push({
      instance: instance.instanceId,
      primitive: j / 3,
      material: section.material.id,
    });
  }
}
const oracle = createTriangleQuery(triangles),
  rows = [];
const labels = [
  'no-card',
  'stale',
  'card-normal',
  'projection',
  'empty-texel',
  'texel-normal',
  'depth',
  'cancelled-shading-normal',
  'mapped',
];
for (let wi = 0; wi < model.works.length; wi += 4) {
  const name = gpu.works[wi].section,
    work = model.works[wi + 3],
    projections = initial(work, 6),
    settings = initial(work, 8),
    resolution = settings.getUint32(4, true),
    cardCount = settings.getUint32(0, true);
  const row = manifest.cases.find((r) => r.name === name),
    cohort = await json(worldPath, row.queryFile),
    facts = inspection.rows.find((r) => r.name === name);
  const h = view(await read(outputPath, `${name}-query.bin`)),
    s = view(await read(outputPath, `${name}-samples.bin`));
  assert.equal(h.byteLength, cohort.rays.length * 64);
  assert.equal(s.byteLength, cohort.rays.length * 4 * 112);
  assert.equal(facts.perRay.length, cohort.rays.length);
  const planes = [];
  for (let binding = 9; binding <= 13; binding++) {
    const resource = model.resources.find(
      (r) => r.resourceId === work.bindings.find((b) => b.binding === binding).resourceId,
    );
    const desc = gpu.cardTextures.find((t) => t.id === resource.descriptor.sourceHandleId);
    assert(desc);
    const bytes = await read(outputPath, desc.file);
    const seed = tape.bootstrap.find((r) => r.handleId === desc.id);
    assert.equal(seed?.initialData.length, 1);
    assert.deepEqual(
      bytes,
      tape.blobs.find((b) => b.hash === seed.initialData[0].hash).bytes,
      'Card readback must match its captured initial texture seed',
    );
    planes.push({ data: view(bytes), ...desc.desc.size });
  }
  const value = (plane, t, c) => halfToFloat(planes[plane].data.getUint16(t * 8 + c * 2, true));
  const evaluate = (position, normal, instance, margin) => {
    let state = 0,
      best = -1,
      selected = null;
    const counts = {};
    let nearestRejected = null;
    const record = (s) => {
      state = Math.max(state, s);
      counts[labels[s]] = (counts[labels[s]] ?? 0) + 1;
    };
    for (let card = 0; card < cardCount; card++) {
      const b = card * 80;
      if (projections.getUint32(b + 64, true) !== instance) continue;
      if (projections.getUint32(b + 68, true) === 0) {
        record(1);
        continue;
      }
      const p = Array.from({ length: 16 }, (_, i) => projections.getFloat32(b + i * 4, true)),
        origin = p.slice(0, 3),
        u = p.slice(4, 7),
        v = p.slice(8, 11),
        n = p.slice(12, 15);
      const angle = dot(normal, n);
      if (angle < 0.5) {
        record(2);
        continue;
      }
      const rel = sub(position, origin),
        uv = [dot(rel, u) / p[7], dot(rel, v) / p[11]],
        edge = Math.hypot(
          ...uv.map((x, a) => (x - Math.max(0, Math.min(1, x))) * [p[7], p[11]][a]),
        );
      if (edge > margin) {
        record(3);
        continue;
      }
      const depth = -dot(rel, n) / p[15],
        tolerance = margin + (0.5 * Math.hypot(p[7], p[11])) / resolution + p[15] / 1024;
      const xy = uv.map((x) => Math.max(0, Math.min(resolution - 1, x * resolution - 0.5))),
        base = xy.map(Math.floor),
        f = xy.map((v, a) => v - base[a]);
      let support = 0,
        error = 0;
      const texels = [],
        weights = [],
        positions = [],
        shading = [0, 0, 0];
      const tile = [
        card % (planes[0].width / resolution),
        Math.floor(card / (planes[0].width / resolution)),
      ].map((v) => v * resolution);
      for (let tap = 0; tap < 4; tap++) {
        const offset = [tap & 1, tap >> 1],
          weight = offset.reduce((w, v, a) => w * (v ? f[a] : 1 - f[a]), 1);
        if (weight <= 0) continue;
        const local = offset.map((v, a) => Math.min(resolution - 1, base[a] + v)),
          x = tile[0] + local[0],
          y = tile[1] + local[1],
          t = y * planes[0].width + x;
        if (value(3, t, 3) !== 1) {
          record(4);
          continue;
        }
        if (dot(oct(value(1, t, 2), value(1, t, 3)), normal) < 0.5) {
          record(5);
          continue;
        }
        const z = planes[4].data.getFloat32(t * 4, true),
          delta = Math.abs(depth - z) * p[15];
        const sampledPosition = origin.map(
          (x, a) =>
            x +
            ((u[a] * (local[0] + 0.5)) / resolution) * p[7] +
            ((v[a] * (local[1] + 0.5)) / resolution) * p[11] -
            n[a] * z * p[15],
        );
        if (delta > tolerance) {
          record(6);
          if (!nearestRejected || delta < nearestRejected.delta)
            nearestRejected = { card, texel: t, delta, tolerance, sampledPosition };
          continue;
        }
        support += weight;
        error += delta * weight;
        texels.push(t);
        weights.push(weight);
        positions.push(sampledPosition);
        oct(value(1, t, 0), value(1, t, 1)).forEach((n, a) => {
          shading[a] += n * weight;
        });
      }
      if (support > 0 && Math.hypot(...shading) < 1e-10) {
        record(7);
        continue;
      }
      if (support > 0) {
        const score = angle - (error / support / Math.max(tolerance, 1e-8)) * 0.1;
        record(8);
        if (score > best) {
          best = score;
          selected = { card, texels, weights: weights.map((w) => w / support), positions };
        }
      }
    }
    return { reason: labels[state], counts, nearestRejected, selected };
  };
  const summary = {
    rays: cohort.rays.length,
    gpuDecisionDifferences: 0,
    gpuCardDifferences: [],
    gpuSupportDifferences: [],
    maximumWeightDelta: 0,
    unmappedReasons: {},
    exactZeroMarginReasons: {},
    exactSameMarginReasons: {},
  };
  const perRay = [];
  for (let i = 0; i < cohort.rays.length; i++) {
    const ray = cohort.rays[i],
      status = h.getUint32(i * 64, true),
      position = [0, 1, 2].map((a) => h.getFloat32(i * 64 + 32 + a * 4, true)),
      normal = [0, 1, 2].map((a) => h.getFloat32(i * 64 + 48 + a * 4, true));
    const hit = { primitive: -1, distance: 0, frontFace: false };
    const exactHit =
      ray.mask !== 0 && oracle.trace(hit, ray.origin, ray.direction, ray.tMin, ray.tMax);
    if (ray.mask === 0) assert(cohort.exact[i] === null || cohort.exact[i] === undefined);
    else if (exactHit) assert(Math.abs(hit.distance - cohort.exact[i]) < 1e-4);
    else assert.equal(cohort.exact[i], null);
    let exact = null,
      actual = [];
    if (exactHit) {
      const tri = triangles[hit.primitive],
        n = normalize(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))),
        p = ray.origin.map((v, a) => v + ray.direction[a] * hit.distance),
        id = identities[hit.primitive];
      exact = {
        ...id,
        t: hit.distance,
        frontFace: hit.frontFace,
        position: p,
        normal: n,
        zeroMargin: evaluate(p, n, id.instance, 0),
        sameMargin: evaluate(p, n, id.instance, row.grid.spacing * 1.5),
      };
      for (const [key, diag] of [
        ['exactZeroMarginReasons', exact.zeroMargin],
        ['exactSameMarginReasons', exact.sameMargin],
      ])
        summary[key][diag.reason] = (summary[key][diag.reason] ?? 0) + 1;
    }
    if (status === 1) {
      for (const [k, candidate] of facts.perRay[i].candidates.entries()) {
        assert.equal(facts.perRay[i].flags, 0, 'refused candidates require a separate diagnostic');
        const result = evaluate(position, normal, candidate.id, row.grid.spacing * 1.5),
          gpuStatus = s.getUint32((i * 4 + k) * 112, true);
        if ((gpuStatus === 1) !== (result.reason === 'mapped')) summary.gpuDecisionDifferences++;
        if (gpuStatus === 1 && result.selected) {
          const offset = (i * 4 + k) * 112;
          const actualSample = { card: s.getUint32(offset + 8, true), texels: [], weights: [] };
          for (let tap = 0; tap < 4; tap++) {
            const weight = s.getFloat32(offset + 96 + tap * 4, true);
            if (weight > 0) {
              actualSample.texels.push(s.getUint32(offset + 80 + tap * 4, true));
              actualSample.weights.push(weight);
            }
          }
          if (actualSample.card !== result.selected.card)
            summary.gpuCardDifferences.push({
              ray: i,
              candidate: k,
              cpu: result.selected.card,
              gpu: actualSample.card,
            });
          else {
            const support = (sample) => {
              const m = new Map();
              sample.texels.forEach((t, j) => {
                m.set(t, (m.get(t) ?? 0) + sample.weights[j]);
              });
              return m;
            };
            const cpu = support(result.selected),
              gpuWeights = support(actualSample);
            if (
              [...new Set([...cpu.keys(), ...gpuWeights.keys()])].some(
                (t) => !cpu.has(t) || !gpuWeights.has(t),
              )
            )
              summary.gpuSupportDifferences.push({ ray: i, candidate: k });
            for (const t of new Set([...cpu.keys(), ...gpuWeights.keys()]))
              summary.maximumWeightDelta = Math.max(
                summary.maximumWeightDelta,
                Math.abs((cpu.get(t) ?? 0) - (gpuWeights.get(t) ?? 0)),
              );
          }
        }
        actual.push({ instance: candidate.id, ...result });
      }
      if (!actual.some((a) => a.reason === 'mapped')) {
        const reason = actual.length
          ? actual.sort((a, b) => labels.indexOf(b.reason) - labels.indexOf(a.reason))[0].reason
          : 'no-object-candidate';
        summary.unmappedReasons[reason] = (summary.unmappedReasons[reason] ?? 0) + 1;
      }
    }
    perRay.push({ ray: i, status, position, normal, exact, actual });
  }
  rows.push({ name, summary, perRay });
}
const result = {
  scope:
    'Independent CPU projection diagnosis from captured GPU Cards, compared with exact unculled triangle geometry; exact material identity is source-section identity, not opacity-qualified shading.',
  sourceCards: cardsPath,
  weightTolerance: 1e-4,
  cardSha256: sha(cardBytes),
  tapeSha256: sha(tapeBytes),
  rows,
};
await writeFile(resolve(outputPath, 'gap-diagnosis.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    rows.map(({ name, summary }) => ({ name, summary })),
    null,
    2,
  ),
);

for (const { name, summary } of rows) {
  assert.equal(summary.gpuDecisionDifferences, 0, `${name}: mapped decisions differ`);
  assert.deepEqual(summary.gpuCardDifferences, [], `${name}: selected Cards differ`);
  assert.deepEqual(summary.gpuSupportDifferences, [], `${name}: contributing texels differ`);
  assert(summary.maximumWeightDelta < 1e-4, `${name}: weights differ`);
}
