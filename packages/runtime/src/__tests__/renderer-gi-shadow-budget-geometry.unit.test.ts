import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import {
  SHADOW_LIGHT_DIRECTION,
  shadowBudgetGeometry,
  shadowComponentWitness,
  shadowTriangleHit,
} from './renderer-gi-shadow-budget-geometry.fixture';

it('retains every original wall vertex and triangle before the loose-bound component', () => {
  const original = createBoxGeometry(8, 8, 0.25).unwrap();
  const mesh = shadowBudgetGeometry();
  expect(mesh.indices?.subarray(0, 36)).toEqual(original.indices);
  for (const attribute of ['position', 'normal', 'uv', 'tangent'] as const) {
    const before = original.attributes[attribute] as Float32Array;
    const after = mesh.attributes[attribute] as Float32Array;
    expect(after.subarray(0, before.length), attribute).toEqual(before);
  }
  expect(mesh.aabb).toEqual(new Float32Array([-4, -4, -0.125, 4.3125, 4, 0.5625]));
});

it('checks all appended triangles against a dense floor and catches a crossing negative control', () => {
  const receivers: [number, number, number][] = [];
  for (let x = -4; x <= 4; x += 0.25)
    for (let z = -6; z <= 2; z += 0.25) receivers.push([x, -1.375, z]);
  const result = shadowComponentWitness(shadowBudgetGeometry(), receivers);
  expect(result).toEqual({
    receiverCount: 1089,
    triangleChecks: 13068,
    minimumLateralMargin: 0.1875,
    originalWallTriangles: 12,
    appendedTriangles: 12,
  });
  const origin = [0, -1.375, -2] as const;
  // A perpendicular plane through the same authored light ray must be detected.
  expect(
    shadowTriangleHit(
      origin,
      SHADOW_LIGHT_DIRECTION,
      [-1, -0.5, -3.5],
      [1, -0.5, -3.5],
      [0, -0.5, -2],
    ),
  ).toBeGreaterThan(0);
  expect(
    shadowTriangleHit(origin, SHADOW_LIGHT_DIRECTION, [-1, -2, -3.5], [1, -2, -3.5], [0, -2, -2]),
  ).toBeUndefined();
});

it('rejects non-finite receiver evidence before claiming a clear triangle ray', () => {
  for (const value of [NaN, Infinity, -Infinity])
    expect(() => shadowComponentWitness(shadowBudgetGeometry(), [[value, -1.375, -2]])).toThrow(
      /finite receiver/,
    );
});
