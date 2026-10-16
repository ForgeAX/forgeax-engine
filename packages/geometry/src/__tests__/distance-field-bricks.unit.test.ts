import { expect, it } from 'vitest';
import { sampleMeshDistanceField } from '../distance-field';
import { buildVisibilityDistanceField } from '../visibility-distance-field';

it('cooks sparse visibility across more than eight million logical samples without a dense allocation', async () => {
  const result = await buildVisibilityDistanceField(
    [-15, -5, -9, -14.8, -5, -9, -15, -4.8, -9, 15, 5, 9, 15.2, 5, 9, 15, 5.2, 9],
    [0, 1, 2, 3, 4, 5],
    { voxelSize: 0.08, triangleSidedness: [1, 1] },
  );
  expect(result.ok, result.ok ? '' : result.error.detail.reason).toBe(true);
  if (!result.ok) return;
  expect(result.value.dimensions.reduce((a, b) => a * b)).toBeGreaterThan(8_388_608);
  expect(result.value.values.byteLength).toBeLessThan(1024 * 1024);
  expect(sampleMeshDistanceField(result.value, [0, 0, 0])).toBeCloseTo(4 * Math.sqrt(3) * 0.08, 6);
}, 120_000);

it('counts address tables and unique payloads against the unchanged 32 MiB CPU budget', async () => {
  const { FieldBrickBuilder, MAX_DISTANCE_FIELD_BYTES } = await import('../distance-field-bricks');
  const b = new FieldBrickBuilder([514, 514, 514]),
    payload = new Float32Array(64);
  let i = 0;
  while (true) {
    payload.fill(i + 1);
    if (!b.store(i, payload)) break;
    i++;
  }
  const result = b.finish();
  expect(result.values.length).toBe(i * 64);
  expect(result.values.byteLength + result.bricks.byteLength).toBeLessThanOrEqual(
    MAX_DISTANCE_FIELD_BYTES,
  );
  expect(result.values.byteLength + result.bricks.byteLength + 256).toBeGreaterThan(
    MAX_DISTANCE_FIELD_BYTES,
  );
  payload.fill(1);
  expect(b.store(i, payload)).toBe(true);
});

it('preserves signed-zero bits and resolves collisions by comparing complete f32 bricks', async () => {
  const { FieldBrickBuilder } = await import('../distance-field-bricks');
  const hash = (words: Uint32Array) =>
    words.reduce((h, w) => Math.imul(h ^ w, 16777619) >>> 0, 2166136261);
  const first = new Float32Array(64),
    second = new Float32Array(64),
    words = new Uint32Array(second.buffer);
  for (let i = 1; i < 1000; i++) {
    words[0] = i;
    words[63] =
      (hash(words.subarray(0, 63)) ^ Math.imul(hash(new Uint32Array(first.buffer)), 899433627)) >>>
      0;
    if (Number.isFinite(second[63])) break;
  }
  expect(second.every(Number.isFinite)).toBe(true);
  expect(hash(words)).toBe(hash(new Uint32Array(first.buffer)));
  const b = new FieldBrickBuilder([16, 4, 4]);
  expect(b.store(0, first)).toBe(true);
  expect(b.store(1, second)).toBe(true);
  expect(b.store(2, first)).toBe(true);
  first[0] = -0;
  expect(b.store(3, first)).toBe(true);
  const result = b.finish();
  expect(result.bricks).toEqual(new Uint32Array([0, 64, 0, 128]));
  expect(Object.is(result.values[128], -0)).toBe(true);
});

it('refuses corrupt brick addresses, padding and unreferenced payloads before artifact publication', async () => {
  const { encodeMeshDistanceField, decodeMeshDistanceField, validateMeshDistanceField } =
    await import('../distance-field-artifact');
  const field = (
    await buildVisibilityDistanceField([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 0.3,
      triangleSidedness: [1],
    })
  ).unwrap();
  expect(validateMeshDistanceField(field).ok).toBe(true);
  for (const offset of [1, 0xffffffff, field.values.length]) {
    const bricks = field.bricks.slice();
    bricks[0] = offset;
    expect(validateMeshDistanceField({ ...field, bricks }).ok).toBe(false);
  }
  const values = new Float32Array(field.values.length + 64);
  values.set(field.values);
  expect(validateMeshDistanceField({ ...field, values }).ok).toBe(false);
  const invalid = field.values.slice();
  const offset = field.bricks[field.bricks.length - 1] ?? 0;
  invalid[offset + 63] = (invalid[offset + 63] ?? 0) + 0.01;
  expect(validateMeshDistanceField({ ...field, values: invalid }).ok).toBe(false);
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  const decoded = (await decodeMeshDistanceField(bytes, field.meshDigest)).unwrap();
  expect(decoded).toEqual(field);
  // A checksum-valid older dense version is stale, even if other metadata matches.
  const headerLength = new DataView(bytes.buffer).getUint32(0, true);
  const text = new TextDecoder().decode(bytes.subarray(4, 4 + headerLength));
  const older = bytes.slice();
  older.set(new TextEncoder().encode(text.replace('"version":4', '"version":3')), 4);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', older.subarray(0, -64))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  older.set(new TextEncoder().encode(digest), older.length - 64);
  expect((await decodeMeshDistanceField(older, field.meshDigest)).ok).toBe(false);
});
