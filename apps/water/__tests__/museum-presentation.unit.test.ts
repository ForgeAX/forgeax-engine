import type { App } from '@forgeax/engine/app';
import { createBoxGeometry, interleavedMesh } from '@forgeax/engine/geometry';
import { ok, type MeshAsset } from '@forgeax/engine/types';
import { expect, it } from 'vitest';
import { dressWaterMuseum } from '../museum-presentation';

it('builds museum batches from admitted interleaved mesh storage', async () => {
  const box = interleavedMesh(createBoxGeometry(1, 1, 1).unwrap());
  expect(box.attributes.position.length).toBe(0);
  const batches: MeshAsset[] = [];
  let nextHandle = 1;
  const app = {
    assets: {
      load: async () => ok(nextHandle++),
      read: () => ok(box),
      create: (mesh: MeshAsset) => {
        batches.push(mesh);
        return ok(nextHandle++);
      },
      release: () => ok(undefined),
    },
    world: { spawn: () => ok(nextHandle++) },
  } as unknown as App;

  const result = await dressWaterMuseum(app, [0, 0, 0], [20, 10, 20]);
  expect(batches.length).toBeGreaterThan(0);
  expect(result.entities.length).toBe(batches.length + 2);
  for (const mesh of batches) {
    expect(mesh.vertices.length).toBeGreaterThan(0);
    expect(mesh.indices?.length).toBeGreaterThan(0);
    expect(Array.from(mesh.vertices).every(Number.isFinite)).toBe(true);
  }
});
