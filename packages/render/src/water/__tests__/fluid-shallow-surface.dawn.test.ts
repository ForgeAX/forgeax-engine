import { expect, it } from 'vitest';
import { rasterProbe } from './fluid-normal-gpu';

it('keeps dry terrain out of the version-two visible water surface', async () => {
  const size = 8;
  const field = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const bed = (x - 3) * 0.5;
      field.set([Math.max(-bed, 0), bed, 0, 1], (y * size + x) * 4);
    }
  const values = new Float32Array(80);
  values.set([size, size, 1 / 90, 0]);
  values.set([0, 0, 8, 8], 4);
  values[22] = 1;
  values[28] = 1;
  values[58] = 2;
  values.set([2, 0, 0, 0.2], 72);
  const pixels = await rasterProbe(
    'normal-height',
    size,
    [field],
    values,
    [
      [2, 4],
      [3, 4],
      [4, 4],
      [5, 4],
    ],
    false,
  );
  for (const pixel of pixels) {
    // Flat normals may retain negative zero on a native backend; no nonzero value is admitted.
    expect(pixel.slice(0, 3).map(Math.abs), 'dry bed cannot lift or tilt a water surface').toEqual([
      0, 0, 0,
    ]);
  }
});

it.each([
  0, 4,
])('retains the constant-depth bed at water level %i during advection', async (level) => {
  const size = 8;
  const field = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) field.set([2, level - 2, 0, 1], i * 4);
  const values = new Float32Array(80);
  values.set([size, size, 1 / 90, 0]);
  values.set([0, 0, 8, 8], 4);
  values[20] = 2;
  values[29] = level;
  values[58] = 2;
  const [surface] = await rasterProbe(
    'advect-height',
    size,
    [field, new Float32Array(field.length), new Float32Array(field.length)],
    values,
    [[4, 4]],
    false,
  );
  expect(surface?.[0]).toBeCloseTo(2, 6);
  expect(surface?.[1]).toBeCloseTo(level - 2, 6);
});

it.each([
  0, 4,
])('keeps version-two shallow water level %i over a sloping bed and retains version-one displacement', async (level) => {
  const size = 8;
  const field = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const bed = -3 + x * 0.2;
      field.set([level - bed, bed, 0, 1], (y * size + x) * 4);
    }
  const values = new Float32Array(80);
  values.set([size, size, 1 / 90, 0]);
  values.set([0, 0, 8, 8], 4);
  values[22] = 1;
  values[28] = 1;
  values[29] = level;
  values[58] = 2;
  values.set([2, 0, 0, 0.2], 72);
  const pixels = [
    [2, 4],
    [5, 4],
  ] as const;
  const current = await rasterProbe('normal-height', size, [field], values, pixels, false);
  for (const pixel of current) {
    expect(pixel[0]).toBeCloseTo(0, 6);
    expect(pixel[1]).toBeCloseTo(0, 6);
    expect(pixel[2], 'a flat free surface cannot inherit the inverse bed slope').toBeCloseTo(0, 6);
  }
  values[58] = 1;
  const legacy = await rasterProbe('normal-height', size, [field], values, pixels, false);
  expect(legacy[0]?.[2]).toBeCloseTo(level + 0.6, 6);
  expect(legacy[1]?.[2]).toBeCloseTo(level, 6);
});

it('allows compression to raise depth, preserves foam and leaves still water at rest', async () => {
  const size = 8;
  const field = new Float32Array(size * size * 4);
  const velocity = new Float32Array(field.length);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      field.set([2, -2, 0.3, 1], (y * size + x) * 4);
      velocity.set([-x, 0, 0, 1], (y * size + x) * 4);
    }
  const values = new Float32Array(80);
  values.set([size, size, 0.1, 0]);
  values.set([0, 0, 7, 7], 4);
  values[58] = 2;
  const [compressed] = await rasterProbe(
    'height-divergence',
    size,
    [field, velocity],
    values,
    [[4, 4]],
    false,
  );
  expect(compressed?.[0], 'converging flow must raise the free surface').toBeCloseTo(2 / 0.9, 6);
  expect(compressed?.[2], 'bed elevation is not foam').toBeCloseTo(0.3, 6);
  const [rest] = await rasterProbe(
    'height-divergence',
    size,
    [field, new Float32Array(field.length)],
    values,
    [[4, 4]],
    false,
  );
  expect(rest?.slice(0, 3)).toEqual([2, -2, expect.closeTo(0.3, 6)]);
});
