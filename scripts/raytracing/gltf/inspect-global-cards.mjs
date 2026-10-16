import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFrameModel, decodeTape } from '../../../packages/rhi-debug/dist/index.mjs';
import { sdfStorageCode } from './sdf-storage.mjs';

const output = resolve(process.argv[2]),
  prior = resolve(process.argv[3]);
const load = async (name, dir = output) => new Uint8Array(await readFile(resolve(dir, name)));
const json = async (name) => JSON.parse(new TextDecoder().decode(await load(name)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const tape = decodeTape(await load('global-cards.rhitape')).unwrap(),
  model = buildFrameModel(tape);
const before = decodeTape(await load('global-compose.rhitape', prior)).unwrap(),
  oldModel = buildFrameModel(before);
const report = await json('gpu.json');
const initial = (t, w, b) => {
  const id = w.bindings.find((r) => r.binding === b)?.resourceId;
  assert(id);
  const seed = t.bootstrap.find((r) => r.handleId === id);
  assert.equal(seed?.initialData.length, 1);
  return t.blobs.find((r) => r.hash === seed.initialData[0].hash).bytes;
};
assert.deepEqual(model.unseededResources, []);
assert.deepEqual(report.gpuErrors, []);
assert.deepEqual(report.errors, []);
assert(report.works.every((w) => w.differentBytes === 0));
const half = (n) => {
  const sign = n & 32768 ? -1 : 1,
    e = (n >> 10) & 31,
    m = n & 1023;
  return (
    sign *
    (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15))
  );
};
const rows = [];
for (let wi = 0; wi < model.works.length; wi += 4) {
  const [composition, query, selection, sampling] = model.works.slice(wi, wi + 4),
    name = report.works[wi].section;
  const oldWork = oldModel.works.find(
    (w) =>
      sha(initial(before, w, 0)) === sha(initial(tape, composition, 0)) &&
      w.bindings.length === 5 &&
      w.pipeline.status === 'available' &&
      w.bindings[4]?.resourceId.startsWith('buffer:'),
  );
  assert(oldWork, 'original composition inputs unavailable');
  for (const binding of [0, 1, 2, 3])
    assert.equal(sha(initial(tape, composition, binding)), sha(initial(before, oldWork, binding)));
  for (const [a, b] of [
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
  ])
    assert.equal(selection.bindings[a].resourceId, composition.bindings[b].resourceId);
  assert.equal(selection.bindings[0].resourceId, query.bindings[3].resourceId);
  assert.deepEqual(selection.bindings, sampling.bindings);
  const hits = await load(`${name}-query.bin`),
    candidates = await load(`${name}-candidates.bin`),
    samples = await load(`${name}-samples.bin`);
  assert.equal(
    sha(hits),
    sha(await load(`${name}-query.bin`, prior)),
    'association must preserve original query results',
  );
  const h = view(hits),
    c = view(candidates),
    s = view(samples),
    ins = view(initial(tape, selection, 1)),
    fields = view(initial(tape, selection, 2)),
    bounds = view(initial(tape, selection, 3));
  const grid = view(initial(tape, selection, 4)),
    card = view(initial(tape, selection, 6));
  const count = hits.length / 64,
    spacing = grid.getFloat32(12, true),
    radius = spacing * 1.5,
    objects = grid.getUint32(28, true);
  assert.equal(candidates.length, count * 32);
  assert.equal(samples.length, count * 4 * 112);
  assert.equal(selection.drawCall.x, Math.ceil(count / 64));
  assert.equal(sampling.drawCall.x, Math.ceil(count / 64));
  for (const b of [5, 7]) assert(initial(tape, selection, b).every((v) => v === 0));
  const planes = [];
  for (let b = 9; b <= 13; b++) {
    const id = sampling.bindings.find((r) => r.binding === b).resourceId;
    const textureView = model.resources.find((r) => r.resourceId === id);
    // Bindings refer to views; descriptor owns their underlying texture handle.
    const textureId = textureView.descriptor.sourceHandleId;
    const row = report.cardTextures.find((r) => r.id === textureId);
    assert(row, JSON.stringify(textureView.descriptor));
    planes.push({
      view: view(await load(row.file)),
      width: row.desc.size.width,
      height: row.desc.size.height,
    });
  }
  const texel = (plane, index, ch = 0) =>
    plane === 4
      ? planes[plane].view.getFloat32(index * 4, true)
      : half(planes[plane].view.getUint16((index * 4 + ch) * 2, true));
  const scalar = (i, p) => {
    const base = i * 144,
      origin = [0, 1, 2].map((a) => ins.getFloat32(base + 96 + a * 4, true)),
      step = ins.getFloat32(base + 108, true),
      dims = [0, 1, 2].map((a) => ins.getUint32(base + 84 + a * 4, true));
    const q = p.map((v, a) => Math.max(0, Math.min(dims[a] - 1, (v - origin[a]) / step))),
      cell = q.map((v, a) => Math.min(Math.floor(v), dims[a] - 2)),
      f = q.map((v, a) => v - cell[a]);
    const offset = ins.getUint32(base + 80, true),
      packed = ins.getFloat32(base + 140, true) > 0.5,
      band = ins.getFloat32(base + 124, true);
    let value = 0;
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          const at = ((cell[2] + z) * dims[1] + cell[1] + y) * dims[0] + cell[0] + x;
          const v = packed
            ? Math.max(-1, sdfStorageCode(fields, offset, dims, at) / 32767) * band
            : fields.getFloat32((offset + at) * 4, true);
          value += v * [x, y, z].reduce((w, b, a) => w * (b ? f[a] : 1 - f[a]), 1);
        }
    return value;
  };
  const counts = {
    rays: count,
    hits: 0,
    candidateRays: 0,
    mappedRays: 0,
    mappedCandidates: 0,
    staleCandidates: 0,
    refusedRays: 0,
    multipleCandidateRays: 0,
  };
  let maxMaterialDelta = 0;
  const perRay = [];
  for (let i = 0; i < count; i++) {
    const state = h.getUint32(i * 64, true),
      normal = [0, 1, 2].map((a) => h.getFloat32(i * 64 + 48 + a * 4, true));
    const position = [0, 1, 2].map((a) => h.getFloat32(i * 64 + 32 + a * 4, true)),
      world = position.map((v, a) => v + (normal[a] * spacing) / 2);
    const expected = [];
    let flags = 0;
    if (state === 1) {
      counts.hits++;
      if (normal.reduce((n, v) => n + v * v, 0) < 0.5) flags |= 4;
      else
        for (let j = 0; j < objects; j++) {
          const base = j * 144,
            bb = j * 48;
          if (ins.getUint32(base + 76, true) === 0) continue;
          const p = [0, 1, 2].map((a) =>
            [0, 1, 2, 3].reduce(
              (n, k) => n + ins.getFloat32(base + (k * 4 + a) * 4, true) * (k === 3 ? 1 : world[k]),
              0,
            ),
          );
          const lo = [0, 1, 2].map((a) => bounds.getFloat32(bb + a * 4, true)),
            hi = [0, 1, 2].map((a) => bounds.getFloat32(bb + 16 + a * 4, true));
          const scale = [0, 1, 2].map((a) => bounds.getFloat32(bb + 32 + a * 4, true)),
            q = p.map((v, a) => Math.max(lo[a] - v, v - hi[a]) * scale[a]);
          const box = Math.hypot(...q.map((v) => Math.max(0, v))) + Math.min(0, Math.max(...q));
          if (box >= radius) continue;
          if (ins.getUint32(base + 80, true) === 0xffffffff) {
            flags |= 1;
            continue;
          }
          const distance = Math.max(
            scalar(
              j,
              p.map((v, a) => Math.max(lo[a], Math.min(hi[a], v))),
            ) *
              bounds.getFloat32(bb + 44, true) +
              Math.max(box, 0),
            box,
          );
          if (Math.abs(distance) < radius)
            expected.push({ id: ins.getUint32(base + 64, true), distance });
        }
    }
    expected.sort((a, b) => a.distance - b.distance || a.id - b.id);
    if (expected.length > 4) flags |= 2;
    assert.equal(
      c.getUint32(i * 32, true),
      Math.min(expected.length, 4),
      `candidate count ${name}:${i}`,
    );
    assert.equal(c.getUint32(i * 32 + 4, true), flags);
    assert.equal(c.getUint32(i * 32 + 8, true), state);
    assert.equal(c.getUint32(i * 32 + 12, true), expected.length);
    counts.candidateRays += Number(expected.length > 0);
    counts.multipleCandidateRays += Number(expected.length > 1);
    counts.refusedRays += Number(flags !== 0);
    const mapped = [];
    for (let k = 0; k < 4; k++) {
      const id = c.getUint32(i * 32 + 16 + k * 4, true);
      assert.equal(id, expected[k]?.id ?? 0xffffffff);
      const off = (i * 4 + k) * 112,
        status = s.getUint32(off, true);
      assert.equal(s.getUint32(off + 4, true), state);
      assert.equal(s.getUint32(off + 12, true), id);
      counts.staleCandidates += Number(status === 3);
      if (status !== 1) {
        for (let a = 16; a < 80; a += 4) assert.equal(s.getFloat32(off + a, true), 0);
        continue;
      }
      assert.equal(flags, 0);
      assert.equal(state, 1);
      assert(k < expected.length);
      const cardId = s.getUint32(off + 8, true);
      assert.equal(card.getUint32(cardId * 80 + 64, true), id);
      assert.equal(card.getUint32(cardId * 80 + 68, true), 1);
      let weightSum = 0;
      const accum = new Array(11).fill(0),
        texels = [],
        weights = [];
      for (let tap = 0; tap < 4; tap++) {
        const t = s.getUint32(off + 80 + tap * 4, true),
          weight = s.getFloat32(off + 96 + tap * 4, true);
        assert(weight >= 0);
        if (!weight) continue;
        assert.equal(texel(3, t, 3), 1);
        assert(t < planes[0].width * planes[0].height);
        const tileX = Math.floor((t % planes[0].width) / report.resolution),
          tileY = Math.floor(Math.floor(t / planes[0].width) / report.resolution);
        assert.equal(tileY * (planes[0].width / report.resolution) + tileX, cardId);
        for (let ch = 0; ch < 4; ch++) {
          accum[ch] += texel(0, t, ch) * weight;
          accum[ch + 4] += texel(2, t, ch) * weight;
        }
        for (let ch = 0; ch < 3; ch++) accum[ch + 8] += texel(3, t, ch) * weight;
        weightSum += weight;
        texels.push(t);
        weights.push(weight);
      }
      assert(Math.abs(weightSum - 1) < 1e-5);
      for (let ch = 0; ch < 11; ch++) {
        const address = ch < 4 ? 16 + ch * 4 : ch < 8 ? 48 + (ch - 4) * 4 : 64 + (ch - 8) * 4;
        const delta = Math.abs(s.getFloat32(off + address, true) - accum[ch]);
        maxMaterialDelta = Math.max(maxMaterialDelta, delta);
        assert(delta < 1e-4);
      }
      counts.mappedCandidates++;
      mapped.push({
        instance: id,
        card: cardId,
        albedo: [0, 1, 2].map((ch) => s.getFloat32(off + 16 + ch * 4, true)),
        texels,
        weights,
      });
    }
    counts.mappedRays += Number(mapped.length > 0);
    perRay.push({ ray: i, status: state, flags, candidates: expected.slice(0, 4), mapped });
  }
  const costs = report.works.slice(wi, wi + 4).map((work, j) => {
    const ms = report.costs.map((s) => s.gpuNanoseconds[wi + j] / 1e6).sort((a, b) => a - b);
    return {
      stage: work.kind,
      medianMs: (ms[11] + ms[12]) / 2,
      p95Ms: ms[Math.ceil(ms.length * 0.95) - 1],
      maxMs: ms.at(-1),
    };
  });
  rows.push({ name, counts, maxMaterialDelta, costs, perRay });
}
const result = {
  status: 'passed',
  scope:
    'association execution and captured-texel provenance; not geometric/material correspondence or GI acceptance',
  tapeSha256: sha(await load('global-cards.rhitape')),
  rows,
};
await writeFile(resolve(output, 'inspection.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    rows.map(({ perRay, ...r }) => r),
    null,
    2,
  ),
);
