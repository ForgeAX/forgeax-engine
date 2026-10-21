import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { pick } from '../pick';
import { pickTriangle } from '../pick-triangle';
import { pickVertex } from '../pick-vertex';

it('queries current bounds and triangles after a shared Mesh range edit, without rebinding', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const positions = new Float32Array([2, -1, 0, 4, -1, 0, 3, 1, 0]);
  const mesh = assets
    .create({
      kind: 'mesh',
      vertices: positions,
      attributes: { position: positions },
      indices: new Uint16Array([0, 1, 2]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'surface' }],
    })
    .unwrap();
  const entities = Array.from({ length: 32 }, (_, index) =>
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -index] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap(),
  );
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: { projection: 1, left: -2, right: 2, bottom: -2, top: 2, near: 0.1, far: 100 },
      },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  const query = () => pickTriangle(world, camera, 64, 64, 128, 128);
  const fixed = assets.snapshot(mesh).unwrap();
  try {
    expect(query().status).toBe('miss');
    const detached = assets.read(mesh).unwrap();
    new Float32Array((detached.attributes.position as Float32Array).buffer).fill(0);
    positions.fill(0);
    expect(query().status).toBe('miss');
    const worldQuery = vi.spyOn(world, 'query').mockImplementation(() => {
      throw new Error('Asset adoption must not visit its consumers');
    });
    try {
      assets
        .writeRange(mesh, {
          attribute: 'position',
          first: 0,
          values: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
        })
        .unwrap();
    } finally {
      worldQuery.mockRestore();
    }
    expect(query()).toMatchObject({
      status: 'hit',
      hit: {
        entity: entities[0],
        assetHandle: mesh,
        point: [0, 0, 0],
      },
    });
    expect(pick(world, camera, 64, 64, 128, 128)?.entity).toBe(entities[0]);
    expect(pickVertex(world, camera, 64, 64, 128, 128)?.entity).toBe(entities[0]);
    expect(fixed.read<MeshAsset>(mesh).unwrap().aabb).toEqual(
      new Float32Array([2, -1, 0, 4, 1, 0]),
    );
    for (const entity of entities)
      expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(mesh);

    // Topology replacement uses the same identity and must retire the previous triangles.
    const next = assets.read(mesh).unwrap();
    assets
      .replace(mesh, {
        ...next,
        indices: new Uint16Array([0, 1]),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 2,
            vertexCount: 3,
            topology: 'line-list',
            materialSlot: 0,
          },
        ],
      })
      .unwrap();
    expect(query().status).toBe('miss');
  } finally {
    fixed.dispose();
    assets.dispose();
  }
});
