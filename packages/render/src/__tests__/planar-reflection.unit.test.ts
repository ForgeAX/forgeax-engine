import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { buildPlanarReflectionView } from '../capture/planar-view';

const plane = [0, 1, 0, 0] as const;
function camera(orthographic = false) {
  const view = mat4.lookAt(mat4.create(), [0, 3, 5], [0, 0, 0], [0, 1, 0]);
  const world = mat4.invert(mat4.create(), view);
  const projection = orthographic
    ? mat4.orthographicReverseZ(mat4.create(), -4, 4, 4, -4, 0.1, 100)
    : mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 100);
  return { world, projection };
}

describe('planar reflection camera', () => {
  it.each([
    false,
    true,
  ])('reflects the camera and clips the opposite half space (ortho=%s)', (ortho) => {
    const source = camera(ortho);
    const result = buildPlanarReflectionView({ ...source, plane, clipBias: 0 });
    expect(result).toBeDefined();
    if (result === undefined) throw new Error('Reflection view missing');
    [0, -3, 5].forEach((v, i) => {
      expect(result.position[i]).toBeCloseTo(v, 5);
    });
    for (const y of [-0.2, 0, 0.2]) {
      const ndc = mat4.transformVec3(vec3.create(), result.viewProjection, [0, y, 0]);
      if (y < 0) expect(ndc[2]).toBeGreaterThan(1);
      if (y === 0) expect(ndc[2]).toBeCloseTo(1, 5);
      if (y > 0) expect(ndc[2]).toBeLessThan(1);
    }
    const m = result.world;
    const determinant =
      (m[0] ?? 0) * ((m[5] ?? 0) * (m[10] ?? 0) - (m[6] ?? 0) * (m[9] ?? 0)) -
      (m[4] ?? 0) * ((m[1] ?? 0) * (m[10] ?? 0) - (m[2] ?? 0) * (m[9] ?? 0)) +
      (m[8] ?? 0) * ((m[1] ?? 0) * (m[6] ?? 0) - (m[2] ?? 0) * (m[5] ?? 0));
    expect(determinant).toBeCloseTo(1, 5);
    expect(source.projection).toEqual(camera(ortho).projection);
  });

  it('rejects the back face and preserves a vertical translated plane', () => {
    const source = camera();
    expect(
      buildPlanarReflectionView({ ...source, plane: [0, -1, 0, 0], clipBias: 0 }),
    ).toBeUndefined();
    const reflected = buildPlanarReflectionView({ ...source, plane: [-1, 0, 0, 2], clipBias: 0 });
    expect(reflected?.position[0]).toBeCloseTo(4);
  });

  it('skips an otherwise valid camera looking away from the plane', () => {
    const world = mat4.invert(
      mat4.create(),
      mat4.lookAt(mat4.create(), [0, 3, 5], [0, 10, 10], [0, 1, 0]),
    );
    expect(
      buildPlanarReflectionView({ world, projection: camera().projection, plane, clipBias: 0 }),
    ).toBeUndefined();
  });

  it('validates degenerate/non-finite planes and bias', () => {
    for (const bad of [
      [0, 0, 0, 0],
      [0, NaN, 0, 0],
      [0, 1, 0, Infinity],
    ]) {
      expect(() => buildPlanarReflectionView({ ...camera(), plane: bad, clipBias: 0 })).toThrow();
    }
    expect(() => buildPlanarReflectionView({ ...camera(), plane, clipBias: -1 })).toThrow();
  });
});
