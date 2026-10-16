import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import UPNG from 'upng-js';

const root = resolve(process.argv[2]);
const json = async (name) => JSON.parse(await readFile(resolve(root, name), 'utf8'));
const environment = await json('environment.json');
const { width, height } = environment.scene;
const pixels = width * height;
const read = async (mode, seed, frame, suffix = mode === 'raw' ? 'raw' : 'signal') => {
  const bytes = await readFile(resolve(root, `${mode}-${seed}/${frame}-${suffix}.bin`));
  const stride = suffix === 'raw' ? 20 : 4;
  assert.equal(bytes.length, pixels * stride * 4);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const data = new Float64Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    if (suffix === 'raw') {
      assert.equal(words[i * 20 + 3], 1);
      assert.equal(words[i * 20 + 7], 0);
    }
    for (let c = 0; c < 3; c++) {
      const value = floats[i * stride + c];
      assert(Number.isFinite(value) && value >= 0);
      data[i * 3 + c] = value;
    }
  }
  return { bytes, data };
};
const meanReference = async (seed) => {
  const metadata = await json(`raw-${seed}.json`);
  assert.equal(metadata.frames, 512);
  assert.equal(metadata.complete, true);
  const sum = new Float64Array(pixels * 3);
  for (let frame = 1; frame <= 512; frame++) {
    const { data } = await read('raw', seed, frame);
    for (let i = 0; i < sum.length; i++) sum[i] += data[i] / 512;
  }
  return sum;
};
const a = await meanReference(8009),
  b = await meanReference(16001);
const reference = a.map((value, i) => (value + b[i]) / 2);
const luminance = (data, pixel) =>
  0.2126 * data[pixel * 3] + 0.7152 * data[pixel * 3 + 1] + 0.0722 * data[pixel * 3 + 2];
const h = await readFile(resolve(root, 'combined-47/1-history-a.bin'));
assert.equal(h.length, pixels * 96);
const identity = new Uint32Array(h.buffer, h.byteOffset, h.length / 4);
const history = new Float32Array(h.buffer, h.byteOffset, h.length / 4);
const masks = {
  full: new Uint8Array(pixels),
  nonDark: new Uint8Array(pixels),
  boundary: new Uint8Array(pixels),
};
for (let i = 0; i < pixels; i++) {
  masks.full[i] = Number(identity[i * 24 + 18] === 1);
  masks.nonDark[i] = Number(masks.full[i] && luminance(reference, i) > 1e-4);
  for (const j of [i % width ? i - 1 : i, i >= width ? i - width : i]) {
    const boundary =
      identity[i * 24 + 18] !== identity[j * 24 + 18] ||
      [8, 9, 10, 11, 12, 13, 14, 15, 17].some(
        (k) => identity[i * 24 + k] !== identity[j * 24 + k],
      ) ||
      Math.abs(history[i * 24 + 6] - history[j * 24 + 6]) >
        0.03 * Math.max(history[i * 24 + 6], history[j * 24 + 6]);
    if (boundary) masks.boundary[i] = masks.boundary[j] = 1;
  }
}
for (let i = 0; i < pixels; i++) masks.boundary[i] &= masks.nonDark[i];
const measure = (data, target, mask) => {
  let mse = 0,
    mean = 0,
    expected = 0,
    count = 0;
  for (let i = 0; i < pixels; i++)
    if (mask[i]) {
      count++;
      for (let c = 0; c < 3; c++) mse += (data[i * 3 + c] - target[i * 3 + c]) ** 2;
      mean += luminance(data, i);
      expected += luminance(target, i);
    }
  assert(count > 0, 'ROI must be populated');
  return {
    pixels: count,
    mse: mse / (count * 3),
    mean: mean / count,
    referenceMean: expected / count,
    relativeBias: expected > 0 ? (mean - expected) / expected : 0,
  };
};
const image = async (name, data) => {
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < 3; c++)
      rgba[i * 4 + c] = Math.round((data[i * 3 + c] / (1 + data[i * 3 + c])) ** (1 / 2.2) * 255);
    rgba[i * 4 + 3] = 255;
  }
  await writeFile(
    resolve(root, `${name}.png`),
    Buffer.from(UPNG.encode([rgba.buffer], width, height, 0)),
  );
};
await image('reference-1024', reference);
await writeFile(resolve(root, 'reference-1024.f64'), Buffer.from(reference.buffer));
const trials = [];
for (const seed of [47, 2017, 4099, 65521]) {
  for (const mode of ['raw', 'spatial', 'temporal', 'combined']) {
    const metadata = await json(`${mode}-${seed}.json`);
    assert.equal(metadata.frames, 64);
    assert.equal(metadata.complete, true);
    const accumulated = new Float64Array(pixels * 3),
      squares = new Float64Array(pixels * 3);
    const frames = [];
    for (let frame = 1; frame <= 64; frame++) {
      const raw = await read(mode, seed, frame, 'raw');
      if (mode !== 'raw')
        assert.deepEqual(
          raw.bytes,
          (await read('raw', seed, frame)).bytes,
          'Same seed/frame must trace exactly the same raw estimates',
        );
      const { data } = mode === 'raw' ? raw : await read(mode, seed, frame);
      if (frame >= 33) {
        frames.push(
          Object.fromEntries(
            Object.entries(masks).map(([name, mask]) => [name, measure(data, reference, mask)]),
          ),
        );
        for (let i = 0; i < data.length; i++) {
          accumulated[i] += data[i] / 32;
          squares[i] += data[i] ** 2 / 32;
        }
      }
      if (frame === 64 && seed === 47) await image(`${mode}-64`, data);
    }
    const rois = Object.fromEntries(
      Object.entries(masks).map(([name, mask]) => {
        const mean = measure(accumulated, reference, mask);
        return [
          name,
          { ...mean, mse: frames.reduce((sum, f) => sum + f[name].mse, 0) / frames.length },
        ];
      }),
    );
    let variance = 0,
      count = 0;
    for (let i = 0; i < pixels; i++)
      if (masks.full[i]) {
        count += 3;
        for (let c = 0; c < 3; c++) {
          const k = i * 3 + c;
          variance += Math.max(0, squares[k] - accumulated[k] ** 2);
        }
      }
    trials.push({ seed, mode, rois, temporalVariance: variance / count });
  }
}
const aggregate = Object.fromEntries(
  ['raw', 'spatial', 'temporal', 'combined'].map((mode) => {
    const rows = trials.filter((trial) => trial.mode === mode);
    return [
      mode,
      {
        mse: rows.reduce((sum, r) => sum + r.rois.full.mse, 0) / rows.length,
        worstNonDarkBias: Math.max(...rows.map((r) => Math.abs(r.rois.nonDark.relativeBias))),
        worstBoundaryBias: Math.max(...rows.map((r) => Math.abs(r.rois.boundary.relativeBias))),
      },
    ];
  }),
);
for (const row of Object.values(aggregate)) row.mseRatioToRaw = row.mse / aggregate.raw.mse;
const passed =
  aggregate.spatial.mseRatioToRaw < 1 &&
  aggregate.temporal.mseRatioToRaw <= 0.65 &&
  aggregate.combined.mseRatioToRaw <= 0.5 &&
  Object.values(aggregate).every(
    (row) => row.worstNonDarkBias <= 0.1 && row.worstBoundaryBias <= 0.1,
  );
const report = {
  status: passed ? 'pass' : 'fail',
  width,
  height,
  equalRawSequences: true,
  reference: {
    disjointSeeds: [8009, 16001],
    samplesEach: 512,
    disagreement: Object.fromEntries(
      Object.entries(masks).map(([name, mask]) => [name, measure(a, b, mask)]),
    ),
  },
  aggregate,
  trials,
  scope: `static ${environment.scene.validationScene ?? 'sponza'} reconstruction quality; no moving-scene or hardware timing acceptance`,
};
await writeFile(resolve(root, 'quality.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, aggregate }, null, 2));
assert(passed, 'Predeclared reconstruction quality criteria failed; inspect quality.json');
