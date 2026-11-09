import { createBoxGeometry, createPrimitiveMesh } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { MeshFrame } from '../mesh-frame';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

it('publishes normal-only and tangent-only Morph channels without allocating position deltas', () => {
  const box = createBoxGeometry(1, 1, 1).unwrap();
  const length = (box.attributes.position as Float32Array).length;
  const mesh = {
    ...box,
    morphTargets: [
      { normal: new Float32Array(length).fill(0.25) },
      { tangent: new Float32Array((length / 3) * 4).fill(-0.5) },
    ],
  };
  const morph = new MeshFrame().with(0, 1, mesh).get(0, 1)?.morph;
  expect(morph).toMatchObject({ vertexCount: length / 3, targetCount: 2, channels: 6 });
  const targetLength = (length / 3) * 7;
  expect(morph?.deltas.length).toBe(targetLength * 2);
  expect(Array.from(morph?.deltas.slice(0, 7) ?? [])).toEqual([0.25, 0.25, 0.25, 0, 0, 0, 0]);
  expect(Array.from(morph?.deltas.slice(targetLength, targetLength + 7) ?? [])).toEqual([
    0, 0, 0, -0.5, -0.5, -0.5, -0.5,
  ]);
});

it('retains geometry across range edits and scopes equal asset handles to their World', () => {
  const aabb = new Float32Array([-1, -2, -3, 1, 2, 3]);
  const mesh = { ...BUILTIN_CUBE, aabb };
  const before = new MeshFrame().with(0, 1, mesh).with(1, 1, mesh);
  aabb[0] = -9;
  const after = before.with(1, 1, mesh);
  expect(before.get(0, 1)?.bounds?.[0]).toBe(-1);
  expect(before.get(1, 1)?.bounds?.[0]).toBe(-1);
  expect(after.get(0, 1)).toBe(before.get(0, 1));
  expect(after.get(1, 1)?.bounds?.[0]).toBe(-9);
  const changed: unknown[] = [];
  after.changesSince(before, (old, next) => changed.push([old, next]));
  expect(changed).toEqual([[before.get(1, 1), after.get(1, 1)]]);
  after.changesSince(after, () => {
    throw new Error('unchanged frame enumerated');
  });
  const removed = after.without(0, 1);
  expect(removed.get(0, 1)).toBeUndefined();
  expect(removed.get(1, 1)).toBe(after.get(1, 1));
});

it('keeps equal handles across many Worlds balanced and retains an isolated delta', () => {
  let before = new MeshFrame();
  for (let world = 0; world < 16384; world++) before = before.with(world, 1, BUILTIN_CUBE);
  const after = before.with(8192, 1, {
    ...BUILTIN_CUBE,
    aabb: new Float32Array([-9, -1, -1, 1, 1, 1]),
  });
  const changed: number[] = [];
  after.changesSince(before, (_old, next) => {
    if (next) changed.push(next.worldId);
  });
  expect(changed).toEqual([8192]);
  expect(after.get(8191, 1)).toBe(before.get(8191, 1));
  expect(after.get(8193, 1)).toBe(before.get(8193, 1));
});
