import { expect, it } from 'vitest';
import { buildMeshDistanceField, type MeshDistanceField } from '../distance-field';
import { fieldBrickNegativeSamples } from '../distance-field-bricks';
import { buildVisibilityDistanceField } from '../visibility-distance-field';

function sphere(
  radius: number,
  scale: readonly [number, number, number],
  rings = 9,
  segments = 13,
) {
  const positions: number[] = [0, radius * scale[1], 0];
  const indices: number[] = [];
  for (let r = 1; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const t = (Math.PI * r) / rings,
        p = (2 * Math.PI * s) / segments;
      positions.push(
        radius * scale[0] * Math.sin(t) * Math.cos(p),
        radius * scale[1] * Math.cos(t),
        radius * scale[2] * Math.sin(t) * Math.sin(p),
      );
    }
  const bottom = positions.length / 3;
  positions.push(0, -radius * scale[1], 0);
  const at = (r: number, s: number) =>
    r === 0 ? 0 : r === rings ? bottom : 1 + (r - 1) * segments + (s % segments);
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = at(r, s),
        b = at(r + 1, s),
        c = at(r + 1, s + 1),
        d = at(r, s + 1);
      if (r > 0) indices.push(a, d, b);
      if (r < rings - 1) indices.push(d, c, b);
    }
  return { positions, indices };
}

async function digest(field: MeshDistanceField): Promise<string> {
  const header = new Float64Array([...field.dimensions, field.quality.negativeSamples]);
  const bytes = new Uint8Array(
    header.byteLength + field.bricks.byteLength + field.values.byteLength,
  );
  bytes.set(new Uint8Array(header.buffer));
  bytes.set(
    new Uint8Array(field.bricks.buffer, field.bricks.byteOffset, field.bricks.byteLength),
    header.byteLength,
  );
  bytes.set(
    new Uint8Array(field.values.buffer, field.values.byteOffset, field.values.byteLength),
    header.byteLength + field.bricks.byteLength,
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

it('publishes byte-stable brick payloads for geometric and visibility fields', async () => {
  const fields: MeshDistanceField[] = [];
  const ellipsoid = sphere(1, [1.3, 0.7, 1]);
  for (const resolution of [9, 14, 17])
    fields.push(
      (
        await buildMeshDistanceField(ellipsoid.positions, ellipsoid.indices, { resolution })
      ).unwrap(),
    );
  const ball = sphere(0.8, [1, 1, 1]);
  const sidedness = Array.from({ length: ball.indices.length / 3 }, (_, i) =>
    i % 5 === 0 ? 1 : 0,
  );
  for (const voxelSize of [0.11, 0.17]) {
    const result = await buildVisibilityDistanceField(ball.positions, ball.indices, {
      voxelSize,
      triangleSidedness: sidedness,
    });
    expect(result.ok, result.ok ? '' : result.error.detail.reason).toBe(true);
    if (result.ok) fields.push(result.value);
  }
  for (const field of fields)
    expect(fieldBrickNegativeSamples(field)).toBe(field.quality.negativeSamples);
  const digests = await Promise.all(fields.map(digest));
  expect(digests).toMatchInlineSnapshot(`
    [
      "38e6cf09b0e91194ec94b8165cedef91af62ddfb26a018edb607488c8afa0272",
      "bfd293e38a947365cf973769fa25b45d319b96b47b329caef145eb31d6f3547a",
      "db1c8b681cbc3d18da227fd3133b49ac48ded14491b9ad54c85343100f9e7cd7",
      "42b4e8a3f233b654195242f0f5148f15d67dace5c9ae801b3edaf599f761d5c6",
      "dc2527b1f337a2798c1a33336749b56959892b7a11abce8367db8d30180df59b",
    ]
  `);
}, 120_000);
