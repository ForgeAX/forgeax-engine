import { mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createBoxGeometry } from '../box';
import { createDecalGeometry } from '../decal';
import { createPlaneGeometry } from '../plane';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}
function area(mesh: MeshAsset | null): number {
  if (mesh === null) throw new Error('expected projected mesh');
  const p = mesh.attributes?.position as Float32Array;
  const ids = mesh.indices as Uint32Array;
  let total = 0;
  for (let i = 0; i < ids.length; i += 3) {
    const a = (ids[i] as number) * 3;
    const b = (ids[i + 1] as number) * 3;
    const c = (ids[i + 2] as number) * 3;
    total +=
      Math.abs(
        ((p[b] as number) - (p[a] as number)) * ((p[c + 1] as number) - (p[a + 1] as number)) -
          ((p[c] as number) - (p[a] as number)) * ((p[b + 1] as number) - (p[a + 1] as number)),
      ) / 2;
  }
  return total;
}

describe('decal mesh projection', () => {
  const plane = () => value(createPlaneGeometry(4, 4));

  it('clips an oversized surface to exactly the projection footprint without moving the surface', () => {
    const mesh = plane();
    const before = structuredClone(mesh);
    const decal = value(createDecalGeometry(mesh, { transform: mat4.identity(mat4.create()) }));
    expect(area(decal)).toBeCloseTo(1, 6);
    if (decal === null) throw new Error('expected projected mesh');
    const positions = decal.attributes?.position as Float32Array;
    const uv = decal.attributes?.uv as Float32Array;
    for (let i = 0; i < positions.length / 3; i++) {
      expect(Math.abs(positions[i * 3] as number)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(positions[i * 3 + 1] as number)).toBeLessThanOrEqual(0.5);
      expect(positions[i * 3 + 2]).toBe(0);
      expect(uv[i * 2]).toBeCloseTo((positions[i * 3] as number) + 0.5);
      expect(uv[i * 2 + 1]).toBeCloseTo(0.5 - (positions[i * 3 + 1] as number));
    }
    expect(mesh).toEqual(before);
  });

  it('supports translated and nonuniformly scaled projection boxes in receiver-local space', () => {
    const transform = mat4.identity(mat4.create());
    transform[0] = 2;
    transform[5] = 0.5;
    transform[10] = 0.1;
    transform[12] = 0.7;
    const decal = value(createDecalGeometry(plane(), { transform }));
    expect(area(decal)).toBeCloseTo(1, 5);
    expect((decal?.attributes?.uv as Float32Array).every((n) => n >= 0 && n <= 1)).toBe(true);
  });

  it('clips the near/far planes and rejects opposite-facing surfaces', () => {
    const transform = mat4.identity(mat4.create());
    transform[14] = 2;
    expect(value(createDecalGeometry(plane(), { transform }))).toBe(null);
    transform[14] = 0;
    transform[10] = -1;
    expect(value(createDecalGeometry(plane(), { transform }))).toBe(null);
    expect(
      area(value(createDecalGeometry(plane(), { transform, normalThreshold: -1 }))),
    ).toBeCloseTo(1);
  });

  it('rejects singular projection and malformed input rather than manufacturing geometry', () => {
    const transform = mat4.identity(mat4.create());
    transform[0] = 0;
    expect(createDecalGeometry(plane(), { transform }).ok).toBe(false);
    transform[0] = 1e-39;
    expect(createDecalGeometry(plane(), { transform }).ok).toBe(false);
    expect(
      createDecalGeometry(plane(), { transform: mat4.identity(mat4.create()), normalThreshold: 2 })
        .ok,
    ).toBe(false);
    const mesh = plane();
    expect(
      createDecalGeometry(
        { ...mesh, indices: new Uint32Array([0, 1, 999]) },
        { transform: mat4.identity(mat4.create()) },
      ).ok,
    ).toBe(false);
    expect(
      createDecalGeometry(
        { ...mesh, attributes: { position: new Float32Array([NaN, 0, 0]) } },
        { transform: mat4.identity(mat4.create()) },
      ).ok,
    ).toBe(false);
  });
  it('clips a rotated projection across multiple cube faces with finite tangent frames', () => {
    const box = value(createBoxGeometry(1, 1, 1));
    const transform = mat4.identity(mat4.create());
    const c = Math.SQRT1_2;
    transform.set([c, 0, -c, 0, 0, 0.8, 0, 0, c, 0, c, 0, 0.5, 0, 0.5, 1]);
    const mesh = value(createDecalGeometry(box, { transform }));
    expect(mesh).not.toBeNull();
    if (!mesh) return;
    const p = mesh.attributes?.position as Float32Array;
    const n = mesh.attributes?.normal as Float32Array;
    const tangent = mesh.attributes?.tangent as Float32Array;
    expect(tangent.every(Number.isFinite)).toBe(true);
    let xFace = 0;
    let zFace = 0;
    for (let i = 0; i < p.length; i += 3) {
      expect(
        Math.abs((p[i] as number) - 0.5) < 1e-5 || Math.abs((p[i + 2] as number) - 0.5) < 1e-5,
      ).toBe(true);
      expect(Math.hypot(n[i] as number, n[i + 1] as number, n[i + 2] as number)).toBeCloseTo(1);
      if ((n[i] as number) > 0.9) xFace++;
      if ((n[i + 2] as number) > 0.9) zFace++;
    }
    expect(xFace).toBeGreaterThan(0);
    expect(zFace).toBeGreaterThan(0);
  });

  it('accepts non-indexed triangles and is a serializable ordinary mesh asset', () => {
    const source = plane();
    const expanded: Record<string, Float32Array> = {};
    for (const name of ['position', 'normal'] as const) {
      const input = source.attributes?.[name] as Float32Array;
      expanded[name] = Float32Array.from(
        Array.from(source.indices as Uint32Array).flatMap((i) =>
          Array.from(input.subarray(i * 3, i * 3 + 3)),
        ),
      );
    }
    const { indices: _, ...base } = source;
    const mesh = value(
      createDecalGeometry(
        {
          ...base,
          attributes: expanded,
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 6,
              topology: 'triangle-list',
              materialSlot: 0,
            },
          ],
        },
        { transform: mat4.identity(mat4.create()) },
      ),
    );
    expect(area(mesh)).toBeCloseTo(1);
    expect(structuredClone(mesh)).toEqual(mesh);
  });
});
