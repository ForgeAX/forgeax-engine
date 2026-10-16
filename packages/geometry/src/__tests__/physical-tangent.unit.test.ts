import { computeTangentVec4 } from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);

describe('physical material tangent admission', () => {
  it('preserves vec4 handedness for a valid rigid tangent', () => {
    const result = computeTangentVec4(
      positions,
      normals,
      new Float32Array([0, 0, 1, 0, 0, 1]),
      new Uint32Array([0, 1, 2]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.value]).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  });

  it('fails closed for a degenerate UV triangle instead of inventing a tangent', () => {
    const result = computeTangentVec4(
      positions,
      normals,
      new Float32Array([0, 0, 0, 0, 0, 0]),
      new Uint32Array([0, 1, 2]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset-parse-failed');
      expect(result.error.detail).toMatchObject({
        reason: expect.stringContaining('material-tangent-required'),
      });
    }
  });
});
