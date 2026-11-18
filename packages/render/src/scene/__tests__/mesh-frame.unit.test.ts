import { createBoxGeometry, createPrimitiveMesh } from '@forgeax/engine-geometry';
import type { AssetGuid } from '@forgeax/engine-types';
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
  const morph = new MeshFrame().with(1, mesh).get(1)?.morph;
  expect(morph).toMatchObject({ vertexCount: length / 3, targetCount: 2, channels: 6 });
  const targetLength = (length / 3) * 7;
  expect(morph?.deltas.length).toBe(targetLength * 2);
  expect(Array.from(morph?.deltas.slice(0, 7) ?? [])).toEqual([0.25, 0.25, 0.25, 0, 0, 0, 0]);
  expect(Array.from(morph?.deltas.slice(targetLength, targetLength + 7) ?? [])).toEqual([
    0, 0, 0, -0.5, -0.5, -0.5, -0.5,
  ]);
});

it('retains geometry across range edits and preserves unrelated Mesh handles', () => {
  const aabb = new Float32Array([-1, -2, -3, 1, 2, 3]);
  const mesh = { ...BUILTIN_CUBE, aabb };
  const before = new MeshFrame().with(1, mesh).with(2, mesh);
  aabb[0] = -9;
  const after = before.with(1, mesh);
  expect(before.get(2)?.bounds?.[0]).toBe(-1);
  expect(before.get(1)?.bounds?.[0]).toBe(-1);
  expect(after.get(2)).toBe(before.get(2));
  expect(after.get(1)?.bounds?.[0]).toBe(-9);
  const changed: unknown[] = [];
  after.changesSince(before, (old, next) => changed.push([old, next]));
  expect(changed).toEqual([[before.get(1), after.get(1)]]);
  after.changesSince(after, () => {
    throw new Error('unchanged frame enumerated');
  });
  const removed = after.without(1);
  expect(removed.get(1)).toBeUndefined();
  expect(removed.get(2)).toBe(after.get(2));
});

it('keeps many Mesh handles balanced and retains an isolated delta', () => {
  let before = new MeshFrame();
  for (let world = 0; world < 16384; world++) before = before.with(world + 1, BUILTIN_CUBE);
  const after = before.with(8192, {
    ...BUILTIN_CUBE,
    aabb: new Float32Array([-9, -1, -1, 1, 1, 1]),
  });
  const changed: number[] = [];
  after.changesSince(before, (_old, next) => {
    if (next) changed.push(next.handle);
  });
  expect(changed).toEqual([8192]);
  expect(after.get(1)).toBe(before.get(1));
  expect(after.get(1)).toBe(before.get(1));
});

it('owns material slot facts and reuses equal bindings across geometry-only revisions', () => {
  const slot = { slotName: 'body', sourceKey: 'body-source' };
  const slots = [slot];
  const before = new MeshFrame().with(1, { ...BUILTIN_CUBE, materialSlots: slots });
  const next = before.with(1, {
    ...BUILTIN_CUBE,
    aabb: new Float32Array([-2, -1, -1, 2, 1, 1]),
    materialSlots: [{ slotName: 'body', sourceKey: 'body-source' }],
  });
  expect(next.get(1)?.materialSlots).toBe(before.get(1)?.materialSlots);
  slot.slotName = 'mutated-alias';
  expect(before.get(1)?.materialSlots[0]?.slotName).toBe('body');
  const changed = next.with(1, {
    ...BUILTIN_CUBE,
    materialSlots: [{ slotName: 'body', sourceKey: 'new-source' }],
  });
  expect(changed.get(1)?.materialSlots).not.toBe(next.get(1)?.materialSlots);
});

it('detaches GUID default bytes and compares their complete values before binding reuse', () => {
  const guid = new Uint8Array(16).fill(7) as AssetGuid;
  const slots = [{ slotName: 'body', defaultMaterial: guid }];
  const before = new MeshFrame().with(1, { ...BUILTIN_CUBE, materialSlots: slots });
  const equal = before.with(1, { ...BUILTIN_CUBE, materialSlots: slots });
  expect(equal.get(1)?.materialSlots).toBe(before.get(1)?.materialSlots);
  guid[0] = 9;
  expect(before.get(1)?.materialSlots[0]?.defaultMaterial).toEqual(new Uint8Array(16).fill(7));
  const changed = equal.with(1, { ...BUILTIN_CUBE, materialSlots: slots });
  expect(changed.get(1)?.materialSlots).not.toBe(equal.get(1)?.materialSlots);
});
