import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { advancePathDistance, createPathSample, preparePath } from '../index';

import { definition } from './fixture';

describe('prepared distance path', () => {
  it('snapshots author data and handles huge steps, reverse, endpoints and zero seconds', () => {
    const source = definition(),
      prepared = preparePath(source).unwrap(),
      sample = createPathSample();
    source.points.fill(500);
    expect(prepared.length).toBeCloseTo(10);
    prepared.sample(sample, 3);
    expect(sample.position[2]).toBeCloseTo(3);
    expect(advancePathDistance(3, 7, 0, 10, true)).toBe(3);
    expect(advancePathDistance(3, -7, 100, 10, true)).toBe(3);
    expect(advancePathDistance(3, 7, 100, 10, false)).toBe(10);
    expect(advancePathDistance(3, -7, 100, 10, false)).toBe(0);
    let small = 3;
    for (let i = 0; i < 1000; i++) small = advancePathDistance(small, -7, 0.1, 10, true);
    expect(small).toBeCloseTo(advancePathDistance(3, -7, 100, 10, true), 8);
  });
  it('measures world length with nonuniform scale without changing local curve shape', () => {
    const source = definition([0, 0, 0, 1, 3, 0, 4, 4, 1, 5, 0, 2]);
    const local = preparePath(source).unwrap();
    const matrix = mat4.fromScaling(mat4.create(), [2, 3, 0.5]);
    const world = preparePath(source, matrix).unwrap();
    const sample = createPathSample(),
      other = createPathSample();
    expect(world.length).toBeGreaterThan(local.length * 2);
    // Endpoints remain the exact transformed controls.
    world.sample(sample, world.length);
    local.sample(other, local.length);
    mat4.transformVec3(other.position, matrix, other.position);
    expect(Array.from(sample.position)).toEqual(Array.from(other.position));
  });
  it('keeps vertical, reverse, duplicate controls and near-antiparallel frames finite', () => {
    for (const points of [
      [0, 0, 0, 0, 10, 0],
      [0, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0.001, 0],
      [0, 0, 0, 1, 0, 0, -1, 0, 0],
    ]) {
      const path = preparePath(definition(points)).unwrap(),
        out = createPathSample();
      for (let i = 0; i <= 64; i++) {
        path.sample(out, (path.length * i) / 64, -1, 5, 2, 0.4);
        expect(Array.from(out.rotation).every(Number.isFinite)).toBe(true);
        expect(quat.length(out.rotation)).toBeCloseTo(1, 5);
      }
    }
  });
  it('corrects the closed frame seam and maps model forward/up and roll explicitly', () => {
    const source = { ...definition([0, 0, 0, 3, 4, 1, -2, 6, 4, -4, 1, -3]), closed: true };
    const path = preparePath(source).unwrap(),
      a = createPathSample(),
      b = createPathSample();
    path.sample(a, 0);
    path.sample(b, path.length);
    expect(Math.abs(quat.dot(a.rotation, b.rotation))).toBeCloseTo(1, 5);
    const straight = preparePath(definition()).unwrap();
    straight.sample(a, 2, -1, 5, 2);
    quat.transformVec3(b.position, a.rotation, [0, 0, -1]);
    expect(vec3.distance(b.position, [0, 0, -1])).toBeLessThan(1e-6);
    expect(() => straight.sample(a, 2, 1, 4, 5)).toThrow();
    expect(() => straight.sample(a, 2, NaN)).toThrow();
  });
  it('treats up as a direction before a large finite instance scale', () => {
    const source = definition([0, 0, 0, 0, 0, 1e-20]);
    source.up.set([1e30, 1e30, 1e30]);
    const matrix = mat4.fromScaling(mat4.create(), [1e20, 1e20, 1e20]);
    const path = preparePath(source, matrix).unwrap();
    const out = createPathSample();
    path.sample(out, path.length / 2);
    expect(Array.from(out.rotation).every(Number.isFinite)).toBe(true);
    expect(quat.length(out.rotation)).toBeCloseTo(1, 5);
  });
  it('rejects illegal author facts and invalid travel instead of mapping them to valid paths', () => {
    for (const points of [
      [],
      [0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, NaN, 0, 1, 1, 1],
      [0, Infinity, 0, 1, 1, 1],
    ])
      expect(preparePath(definition(points)).ok).toBe(false);
    for (const subdivisions of [0, 15, 2.5, 65537])
      expect(preparePath({ ...definition(), subdivisions }).ok).toBe(false);
    expect(preparePath({ ...definition(), up: new Float32Array(3) }).ok).toBe(false);
    expect(preparePath({ ...definition(), parameterization: 17 }).ok).toBe(false);
    expect(preparePath(definition(), mat4.fromScaling(mat4.create(), [0, 0, 0])).ok).toBe(false);
    for (const args of [
      [NaN, 1, 1, 10],
      [0, 1, -1, 10],
      [0, Infinity, 1, 10],
      [0, 1, 1, 0],
    ])
      expect(() =>
        advancePathDistance(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          false,
        ),
      ).toThrow();
  });
});
