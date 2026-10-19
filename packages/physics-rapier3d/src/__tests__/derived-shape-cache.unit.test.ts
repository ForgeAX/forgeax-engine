import type { DerivedShapeInput } from '@forgeax/engine-physics';
import { beforeAll, expect, it, vi } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import type { ColliderDesc, World } from '../../pkg/rapier.mjs';
import { createDerivedCollider } from '../derived-collider.js';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader.js';

let rapier: Rapier3DModule;
beforeAll(async () => {
  rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
});

it.each<DerivedShapeInput>([
  {
    kind: 'convex-compound',
    id: 'convex',
    revision: 1,
    pieces: [boxPoints([0.6, 0, 0], [0.7, 1, 2])],
  },
  {
    kind: 'convex-compound',
    id: 'compound',
    revision: 1,
    pieces: [boxPoints([0.6, 0, 0], [0.7, 1, 2]), boxPoints([1.6, 0, 0], [1.7, 1, 2])],
  },
  {
    kind: 'heightfield',
    id: 'heightfield',
    revision: 1,
    rows: 1,
    columns: 1,
    heights: new Float32Array([0, 0, 0, 0]),
    scale: [2, 1, 2],
  },
  {
    kind: 'voxels',
    id: 'voxels',
    revision: 1,
    regions: new Int32Array([0, 0, 0, 1, 1, 1]),
    voxelSize: [1, 1, 1],
  },
])('releases $id construction geometry while preserving native reconstruction and queries', (input) => {
  const world: World = new rapier.World({ x: 0, y: 0, z: 0 });
  const body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const create = world.createCollider.bind(world);
  let descriptor: ColliderDesc | undefined;
  const spy = vi.spyOn(world, 'createCollider').mockImplementation((desc, parent) => {
    descriptor = desc;
    return create(desc, parent);
  });
  try {
    const collider = createDerivedCollider(rapier, world, body, input);
    expect(collider.isEnabled()).toBe(false);
    const rebuilt = collider.shape;
    // Construction arrays have a separate lifetime from the native collider.
    // A later public shape read reconstructs from native geometry on demand.
    expect(rebuilt).not.toBe(descriptor?.shape);
    expect(rebuilt.type).toBe(descriptor?.shape.type);
    collider.setEnabled(true);
    const point = { x: 0.65, y: 0.5, z: 0.5 };
    const projected = collider.projectPoint(point, true);
    collider.clearShapeCache();
    expect(collider.projectPoint(point, true)).toEqual(projected);
    expect(collider.shape.type).toBe(rebuilt.type);
    const restored: World = rapier.World.restoreSnapshot(world.takeSnapshot());
    try {
      expect(restored.getCollider(collider.handle).projectPoint(point, true)).toEqual(projected);
    } finally {
      restored.free();
    }
  } finally {
    spy.mockRestore();
    world.free();
  }
});
