import { describe, expect, it } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { plane } from './path-tracer.fixture';

describe('shared ray material normal frame', () => {
  it('owns indexed inverse-transpose normals and mirrored tangent handedness', () => {
    const source = plane();
    const n = Math.SQRT1_2;
    const instance = {
      ...source,
      normals: Array.from({ length: 4 }, () => [n, 0, n]).flat(),
      tangents: Array.from({ length: 4 }, () => [n, 0, -n, -1]).flat(),
      transform: [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1],
    };
    const scene = buildRaySurfaceScene([instance]).unwrap();
    expect(scene.attributes.byteLength).toBe(scene.triangleCount * 384);
    const data = new Float32Array(scene.attributes.buffer);
    for (let vertex = 0; vertex < scene.triangleCount * 3; vertex++) {
      const o = vertex * 32;
      expect(data[o + 24]).toBeCloseTo(-2 / Math.sqrt(5), 6);
      expect(data[o + 26]).toBeCloseTo(1 / Math.sqrt(5), 6);
      expect(data[o + 27]).toBe(-1);
      expect(data[o + 28]).toBeCloseTo(-1 / Math.sqrt(5), 6);
      expect(data[o + 30]).toBeCloseTo(-2 / Math.sqrt(5), 6);
      expect(data[o + 31]).toBe(1);
    }
    instance.normals.fill(0);
    instance.tangents.fill(0);
    expect(data[24]).toBeCloseTo(-2 / Math.sqrt(5), 6);
  });

  it('rejects malformed or degenerate authored frames instead of inventing a valid one', () => {
    const p = plane();
    for (const extra of [
      { normals: [0, 0, 1] },
      { normals: new Array(12).fill(0) },
      { normals: new Array(12).fill(NaN) },
      { tangents: new Array(16).fill(0) },
      { tangents: Array.from({ length: 4 }, () => [1, 0, 0, 0.5]).flat() },
      {
        normals: Array.from({ length: 4 }, () => [0, 0, 1]).flat(),
        tangents: Array.from({ length: 4 }, () => [0, 0, 1, 1]).flat(),
      },
    ])
      expect(buildRaySurfaceScene([{ ...p, ...extra }]).ok).toBe(false);
  });
});
