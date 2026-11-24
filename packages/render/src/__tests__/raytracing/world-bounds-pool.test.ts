import { expect, it } from 'vitest';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { SDF_INSTANCE_STRIDE } from '../../raytracing/sdf-query';
import {
  isWorldBoundsPoolSpan,
  packWorldBoundsPool,
  WORLD_BOUNDS_HEADER_BYTES,
  WORLD_BOUNDS_POOL_MAGIC,
  WORLD_BOUNDS_POOL_MAX_BYTES,
  WORLD_BOUNDS_ROW_BYTES,
} from '../../raytracing/world-bounds-pool';
import { recordWorldBoundsIndexMoves } from './world-bounds-index.fixture';

type V = readonly [number, number, number];
it('admits explicit typed spans and rejects legacy, short, nonaligned and excess spans', () => {
  expect(isWorldBoundsPoolSpan(192, 2)).toBe(true);
  expect(isWorldBoundsPoolSpan(208, 2)).toBe(true);
  for (const bytes of [96, 176, 196, WORLD_BOUNDS_POOL_MAX_BYTES + 16])
    expect(isWorldBoundsPoolSpan(bytes, 2)).toBe(false);
  expect(isWorldBoundsPoolSpan(192, 1.5)).toBe(false);
});
const RADIUS = 0.75;
function canonical(count: number, coincident = false) {
  const instances = Array.from({ length: count }, (_, i) => {
    const angle = i * 0.37,
      c = Math.cos(angle),
      s = Math.sin(angle),
      sx = i % 3 === 0 ? -0.7 : 1.3,
      sy = 0.4 + (i % 5) * 0.2,
      sz = 0.6 + (i % 7) * 0.1;
    const translation = coincident
      ? [0, 0, 0]
      : [(i % 8) * 5, (Math.floor(i / 8) % 8) * 5, Math.floor(i / 64) * 5];
    return {
      instanceId: 1000 + count - i,
      geometryId: 1,
      mask: 255,
      transform: [sx * c, sx * s, 0, 0, -sy * s, sy * c, 0, 0, 0, 0, sz, 0, ...translation, 1],
      field: {
        missing: true as const,
        bounds: { min: [-0.5, -0.4, -0.3] as V, max: [0.5, 0.4, 0.3] as V },
      },
    };
  });
  const packed = packGlobalSdfComposition(
    instances,
    {
      origin: [-2, -2, -2],
      dimensions: [2, 2, 2],
      spacing: 1,
      maxDistance: 1,
      coverageDistance: 1,
    },
    { index: false },
  ).unwrap();
  return {
    ...packed,
    data: {
      ...packed.data,
      bounds: packed.data.bounds.slice(
        WORLD_BOUNDS_HEADER_BYTES,
        WORLD_BOUNDS_HEADER_BYTES + Math.max(1, count) * WORLD_BOUNDS_ROW_BYTES,
      ),
    },
  };
}

/** Independent consumer: parse the explicit wire header and its CSR ranges.
 * This reader never imports the builder's binning/envelope helpers. */
function indexedRows(bytes: Uint8Array, point: V) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    u = (word: number) => view.getUint32(word * 4, true),
    f = (word: number) => view.getFloat32(word * 4, true);
  expect(u(0)).toBe(WORLD_BOUNDS_POOL_MAGIC);
  expect(u(1)).toBe(1);
  expect(u(23) * 4).toBe(bytes.length);
  if (u(7) !== 1) return Array.from({ length: u(2) }, (_, row) => row);
  expect(f(11)).toBe(RADIUS);
  for (const word of [16, 17, 19, 21]) expect(u(word) % 4).toBe(0);
  expect(u(21) + 2 * u(22)).toBeLessThanOrEqual(u(23));
  const cell = point.map((p, axis) =>
    Math.floor(Math.fround(Math.fround(p - f(12 + axis)) / f(15))),
  );
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    rows = Array.from(words.subarray(u(19), u(19) + u(20)));
  if (cell.some((value, axis) => value < 0 || value >= u(8 + axis)))
    return Array.from({ length: u(2) }, (_, row) => row);
  const linear = ((cell[2] ?? NaN) * u(9) + (cell[1] ?? NaN)) * u(8) + (cell[0] ?? NaN),
    start = u(u(16) + linear),
    end = u(u(16) + linear + 1);
  rows.push(...words.subarray(u(17) + start, u(17) + end));
  return rows;
}

/** Original box-distance admission evaluated by a direct full roster scan.
 * Uses the actual stored canonical inverse and bounds, not derived world boxes. */
function fullScan(data: ReturnType<typeof canonical>['data'], point: V, count: number) {
  const instances = new DataView(data.instances.buffer),
    bounds = new DataView(data.bounds.buffer),
    rows: number[] = [];
  for (let row = 0; row < count; row++) {
    const first = row * SDF_INSTANCE_STRIDE,
      base = row * WORLD_BOUNDS_ROW_BYTES;
    if (instances.getUint32(first + 76, true) === 0) continue;
    const p = [0, 1, 2].map((axis) => {
      let value = Math.fround(instances.getFloat32(first + 48 + axis * 4, true));
      for (let k = 0; k < 3; k++)
        value = Math.fround(
          value +
            Math.fround(instances.getFloat32(first + (k * 4 + axis) * 4, true) * (point[k] ?? NaN)),
        );
      return value;
    });
    const d = p.map((value, axis) =>
      Math.fround(
        Math.max(
          bounds.getFloat32(base + axis * 4, true) - value,
          value - bounds.getFloat32(base + 16 + axis * 4, true),
        ) * bounds.getFloat32(base + 32 + axis * 4, true),
      ),
    );
    const distance =
      Math.hypot(...d.map((value) => Math.max(value, 0))) + Math.min(0, Math.max(...d));
    if (distance < RADIUS) rows.push(row);
  }
  return rows;
}

it('keeps every full-scan candidate for transformed, mirrored and boundary points', () => {
  const count = 128,
    source = canonical(count),
    pool = packWorldBoundsPool(source.data.bounds, source.data.instances, count, {
      maxBytes: 2 * 1024 ** 2,
      rowCapacity: count,
      index: true,
      candidateRadius: RADIUS,
    }).unwrap();
  expect(pool.indexed).toBe(true);
  const points: V[] = [];
  for (let z = -1; z <= 2; z++)
    for (let y = -1; y <= 16; y++)
      for (let x = -1; x <= 16; x++)
        points.push([
          Math.fround(x * 2.5 + 0.75),
          Math.fround(y * 2.5 - 0.75),
          Math.fround(z * 2.5),
        ]);
  const header = new DataView(pool.bytes.buffer),
    origin = [0, 1, 2].map((axis) => header.getFloat32((12 + axis) * 4, true)),
    spacing = header.getFloat32(60, true);
  for (let axis = 0; axis < 3; axis++)
    for (let cell = 0; cell <= 32; cell++)
      for (const epsilon of [-1e-6, 0, 1e-6]) {
        const point = origin.map((value) => Math.fround(value + spacing * 3)) as [
          number,
          number,
          number,
        ];
        point[axis] = Math.fround((origin[axis] ?? NaN) + spacing * cell + epsilon);
        points.push(point);
      }
  for (const point of points) {
    const actual = indexedRows(pool.bytes, point);
    expect(new Set(actual).size).toBe(actual.length);
    for (const row of fullScan(source.data, point, count))
      expect(actual, `candidate row ${row} lost at ${point}`).toContain(row);
  }
});

it('retains candidates at near-orthogonal and extreme translated coordinate boundaries', () => {
  for (const translation of [0, 2 ** 10, 2 ** 18, 2 ** 26]) {
    const source = canonical(2),
      iv = new DataView(source.data.instances.buffer);
    for (let row = 0; row < 2; row++) {
      const offset = row * SDF_INSTANCE_STRIDE;
      iv.setFloat32(offset + 48, iv.getFloat32(offset + 48, true) - translation, true);
      iv.setFloat32(offset + 16, iv.getFloat32(offset + 16, true) + 1e-6, true);
    }
    const pool = packWorldBoundsPool(source.data.bounds, source.data.instances, 2, {
      maxBytes: 2 * 1024 ** 2,
      rowCapacity: 2,
      index: true,
      candidateRadius: RADIUS,
    }).unwrap();
    let positive = 0;
    for (let sourceRow = 0; sourceRow < 2; sourceRow++) {
      const base = sourceRow * SDF_INSTANCE_STRIDE,
        a = iv.getFloat32(base, true),
        b = iv.getFloat32(base + 16, true),
        c = iv.getFloat32(base + 4, true),
        d = iv.getFloat32(base + 20, true),
        tx = iv.getFloat32(base + 48, true),
        ty = iv.getFloat32(base + 52, true),
        det = a * d - b * c;
      const center: V = [(b * ty - d * tx) / det, (c * tx - a * ty) / det, 0];
      for (let axis = 0; axis < 3; axis++)
        for (const boundary of [-1.25, -0.5, 0, 0.5, 1.25])
          for (const epsilon of [-1e-5, 0, 1e-5]) {
            const point: [number, number, number] = [
              Math.fround(center[0]),
              Math.fround(center[1]),
              0,
            ];
            point[axis] = Math.fround((point[axis] ?? NaN) + boundary + epsilon);
            const actual = indexedRows(pool.bytes, point),
              expected = fullScan(source.data, point, 2);
            positive += expected.length;
            for (const row of expected) expect(actual).toContain(row);
          }
    }
    expect(positive).toBeGreaterThan(0);
  }
});

it('coarsens oversized pressure without changing canonical rows and retains budget fallback', () => {
  const source = canonical(256, true),
    base = WORLD_BOUNDS_HEADER_BYTES + 256 * WORLD_BOUNDS_ROW_BYTES;
  for (const maxBytes of [base, base + 32, 2 * 1024 ** 2]) {
    const pool = packWorldBoundsPool(source.data.bounds, source.data.instances, 256, {
      maxBytes,
      rowCapacity: 256,
      index: true,
      candidateRadius: RADIUS,
    }).unwrap();
    expect(pool.indexed).toBe(maxBytes === 2 * 1024 ** 2);
    expect(pool.bytes.slice(WORLD_BOUNDS_HEADER_BYTES, base)).toEqual(source.data.bounds);
    expect(indexedRows(pool.bytes, [0, 0, 0])).toHaveLength(256);
  }
  expect(
    packWorldBoundsPool(source.data.bounds, source.data.instances, 256, {
      maxBytes: base - 1,
      rowCapacity: 256,
      index: true,
      candidateRadius: RADIUS,
    }).ok,
  ).toBe(false);
});

it('keeps the full transformed-box predicate after coarsening at mid-scale', () => {
  const count = 256,
    source = canonical(count),
    maxBytes = WORLD_BOUNDS_HEADER_BYTES + count * WORLD_BOUNDS_ROW_BYTES + 32768,
    pool = packWorldBoundsPool(source.data.bounds, source.data.instances, count, {
      maxBytes,
      rowCapacity: count,
      index: true,
      candidateRadius: RADIUS,
    }).unwrap(),
    header = new DataView(pool.bytes.buffer);
  expect(pool.indexed).toBe(true);
  expect(pool.bytes.length).toBeLessThanOrEqual(maxBytes);
  expect(Math.max(...[8, 9, 10].map((word) => header.getUint32(word * 4, true)))).toBeLessThan(32);
  for (let z = -1; z <= 7; z++)
    for (let y = -1; y <= 16; y++)
      for (let x = -1; x <= 16; x++) {
        const point: V = [Math.fround(x * 2.5), Math.fround(y * 2.5), Math.fround(z * 2.5)],
          actual = indexedRows(pool.bytes, point);
        expect(new Set(actual).size).toBe(actual.length);
        for (const row of fullScan(source.data, point, count)) expect(actual).toContain(row);
      }
});

it('does not coarsen away an unsupported envelope or duplicate identity', () => {
  const source = canonical(256),
    instances = source.data.instances.slice(),
    data = new DataView(instances.buffer),
    options = {
      maxBytes: WORLD_BOUNDS_POOL_MAX_BYTES,
      rowCapacity: 256,
      index: true,
      candidateRadius: RADIUS,
    };
  // Singular finite affine rows cannot yield a supported conservative envelope.
  for (let column = 0; column < 3; column++) data.setFloat32(column * 16, 0, true);
  const pool = packWorldBoundsPool(source.data.bounds, instances, 256, options).unwrap();
  expect(pool.indexed).toBe(false);
  expect(pool.bytes.slice(WORLD_BOUNDS_HEADER_BYTES)).toEqual(source.data.bounds);
  expect(indexedRows(pool.bytes, [0, 0, 0])).toHaveLength(256);
  data.setUint32(SDF_INSTANCE_STRIDE + 64, data.getUint32(64, true), true);
  expect(packWorldBoundsPool(source.data.bounds, instances, 256, options).ok).toBe(false);
});

it('rejects bad canonical bounds and keeps editable storage disjoint from the index', () => {
  const source = canonical(2),
    options = { maxBytes: 1024 * 1024, rowCapacity: 8, index: false, candidateRadius: RADIUS },
    pool = packWorldBoundsPool(source.data.bounds, source.data.instances, 2, options).unwrap();
  expect(pool.indexed).toBe(false);
  expect(pool.bytes.length).toBe(WORLD_BOUNDS_HEADER_BYTES + 8 * WORLD_BOUNDS_ROW_BYTES);
  expect(pool.bytes.slice(WORLD_BOUNDS_HEADER_BYTES, WORLD_BOUNDS_HEADER_BYTES + 96)).toEqual(
    source.data.bounds,
  );
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const bad = source.data.bounds.slice();
    new DataView(bad.buffer).setFloat32(0, invalid, true);
    expect(packWorldBoundsPool(bad, source.data.instances, 2, options).ok).toBe(false);
    const matrix = source.data.instances.slice();
    new DataView(matrix.buffer).setFloat32(48, invalid, true);
    expect(packWorldBoundsPool(source.data.bounds, matrix, 2, options).ok).toBe(false);
  }
  const inverted = source.data.bounds.slice();
  new DataView(inverted.buffer).setFloat32(0, 100, true);
  expect(packWorldBoundsPool(inverted, source.data.instances, 2, options).ok).toBe(false);
});

it('keeps the production Card candidate cursor indexed across an enclosed placement move', async () => {
  const { originalBounds, small, crossing, smallEditWrites, editWrites } =
    await recordWorldBoundsIndexMoves();
  const point = [0.03125, 0, 0.5] as const;
  const original = indexedRows(originalBounds, point);
  expect(original).toContain(5);
  expect(original.length).toBeLessThan(128);
  expect(smallEditWrites.some(({ target, offset }) => target === 'bounds' && offset === 28)).toBe(
    false,
  );
  expect(indexedRows(small.bounds, point)).toEqual(original);
  expect(editWrites.some(({ target, offset }) => target === 'bounds' && offset === 28)).toBe(true);
  expect(indexedRows(crossing.bounds, [15, -15, 0.5])).toHaveLength(128);
  expect(new DataView(small.settings.buffer).getUint32(60, true)).toBe(2);
  expect(new DataView(crossing.settings.buffer).getUint32(60, true)).toBe(2);
});
