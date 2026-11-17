import { expect, it } from 'vitest';
import { cloneDerivedPhysicsInput } from '../derived-physics.js';

it('owns native primitive dimensions and pose without retaining author arrays', () => {
  const halfExtents: [number, number, number] = [1, 2, 3];
  const origin: [number, number, number] = [4, 5, 6];
  const result = cloneDerivedPhysicsInput({
    entity: 1,
    revision: 1,
    sourceKey: 'primitives',
    shapes: [
      { kind: 'cuboid', id: 'box', revision: 1, halfExtents, origin, rotation: [0, 0, 0, 2] },
      { kind: 'sphere', id: 'ball', revision: 1, radius: 0.5 },
      { kind: 'capsule', id: 'capsule', revision: 1, radius: 0.5, halfHeight: 0 },
      { kind: 'cylinder', id: 'cylinder', revision: 1, radius: 0.5, halfHeight: 1 },
    ],
  }).unwrap();
  halfExtents.fill(100);
  origin.fill(100);
  const shape = result.shapes[0];
  if (shape?.kind !== 'cuboid') throw Error('missing cuboid');
  expect(shape.halfExtents).toEqual([1, 2, 3]);
  expect(shape.origin).toEqual([4, 5, 6]);
  expect(shape.rotation).toEqual([0, 0, 0, 1]);
  expect(Object.isFrozen(shape.halfExtents)).toBe(true);
});

it.each([
  { kind: 'sphere', radius: 0 },
  { kind: 'sphere', radius: 1e-50 },
  { kind: 'sphere', radius: Infinity },
  { kind: 'cuboid', halfExtents: [1, -1, 1] },
  { kind: 'cuboid', halfExtents: [1, 1e40, 1] },
  { kind: 'capsule', radius: 1, halfHeight: -1 },
  { kind: 'cylinder', radius: 1, halfHeight: 0 },
  { kind: 'sphere', radius: 1, halfHeight: 1 },
  { kind: 'sphere', radius: 1, isSensor: 1 },
  { kind: 'sphere', radius: 1, collisionGroups: -1 },
  { kind: 'sphere', radius: 1, rotation: [0, 0, 0, 0] },
  { kind: 'sphere', radius: 1, rotation: 'xxxx' },
  { kind: 'sphere', radius: 1, origin: 'xxx' },
  { kind: 'sphere', radius: 1, origin: new Array(3) },
  { kind: 'cuboid', halfExtents: new Array(3) },
])('refuses invalid primitive fields before native allocation: %j', (patch) => {
  const result = cloneDerivedPhysicsInput({
    entity: 1,
    revision: 1,
    sourceKey: 'invalid',
    shapes: [{ id: 'shape', revision: 1, ...patch }] as never,
  });
  expect(result.ok).toBe(false);
});
