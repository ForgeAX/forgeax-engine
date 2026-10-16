import { assert, describe, expect, it } from 'vitest';
import {
  buildRayReferenceScene,
  packReferenceRays,
  traceReferenceRay,
} from '../../raytracing/scene';
import { mesh, referenceCorpus } from './corpus';

describe('opaque ray reference snapshot', () => {
  it('preserves nearest identity, t interval, masks, barycentrics and reflected winding', () => {
    const { scene, rays } = referenceCorpus();
    const hits = rays.slice(0, 8).map((r) => traceReferenceRay(scene, r));
    expect(hits.map((h) => h?.instanceId ?? null)).toEqual([7, 9, null, null, 12, 18, null, 9]);
    expect(hits[0]).toMatchObject({
      t: 3,
      primitiveId: 0,
      materialId: 0xffabcdef,
      frontFace: true,
      barycentrics: [0.25, 0.5],
    });
    expect(hits[5]?.frontFace).toBe(false);
    expect(hits[7]?.frontFace).toBe(false);
  });
  it('is independent of source mutation and supports empty replacement', () => {
    const instance = mesh();
    const scene = buildRayReferenceScene([instance]).unwrap();
    (instance.positions as number[]).fill(99);
    const ray = referenceCorpus().rays[0];
    assert(ray);
    expect(traceReferenceRay(scene, ray)?.instanceId).toBe(7);
    expect(traceReferenceRay(buildRayReferenceScene([]).unwrap(), ray)).toBe(null);
  });
  it('rejects malformed topology, identities and singular transforms', () => {
    for (const instance of [
      { ...mesh(), indices: [0, 1, 3] },
      { ...mesh(), mask: 256 },
      { ...mesh(), instanceId: 0xffffffff },
      { ...mesh(), positions: [NaN, 0, 0] },
      { ...mesh(), transform: Array(16).fill(0) },
    ])
      expect(buildRayReferenceScene([instance]).ok).toBe(false);
    expect(buildRayReferenceScene([mesh(), mesh()]).ok).toBe(false);
  });
  it('retains zero-area primitives as inactive triangles, matching raster and hardware AS semantics', () => {
    const scene = buildRayReferenceScene([{ ...mesh(), indices: [0, 0, 0] }]).unwrap();
    expect(scene.triangleCount).toBe(1);
    const ray = referenceCorpus().rays[0];
    assert(ray);
    expect(traceReferenceRay(scene, ray)).toBe(null);
  });
  it('rejects invalid or f32-collapsed rays before GPU work', () => {
    const ray = referenceCorpus().rays[0];
    assert(ray);
    for (const r of [
      { ...ray, direction: [0, 0, 0] as const },
      { ...ray, tMax: NaN },
      { ...ray, tMin: -1 },
      { ...ray, tMin: 1, tMax: 1 + 1e-10 },
      { ...ray, mask: 256 },
    ])
      expect(packReferenceRays([r]).ok).toBe(false);
    expect(packReferenceRays([]).ok).toBe(false);
    expect(packReferenceRays([ray]).unwrap().byteLength).toBe(48);
  });
});
