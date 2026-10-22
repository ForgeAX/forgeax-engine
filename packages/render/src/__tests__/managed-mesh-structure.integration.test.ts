import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { extractFrames } from '../render-system-extract-tail';
import { meshDrawSnapshot } from '../scene/mesh-draw';
import { PersistentRenderScene } from '../scene/render-scene';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

it.each([
  false,
  true,
])('adopts Mesh slots through shared bindings and preserves fixed frames (worker=%s)', (worker) => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const red = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
  const green = assets.create(Materials.unlit([0, 1, 0, 1])).unwrap();
  const blue = assets.create(Materials.unlit([0, 0, 1, 1])).unwrap();
  const mesh = assets
    .create({ ...BUILTIN_CUBE, materialSlots: [{ slotName: 'first', defaultMaterial: red }] })
    .unwrap();
  for (let i = 0; i < 1000; i++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [0 as AssetHandle<'material'>, blue] } },
      )
      .unwrap();
  const scene = new PersistentRenderScene({ assets });
  const caches = scene.materialSnapshotCacheStore();
  const lease = createRenderReadLease(world);
  const identity = { source: 'mesh-structure', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  let upserts = 0;
  const draw = () => {
    world.update(0).unwrap();
    if (worker) {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet);
      candidate.accept();
      upserts += packet.upserts.length;
      const result = scene.consumePublication(receiver.accept(packet).unwrap());
      publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      return result;
    }
    return scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) => {
        if (request === 'full') upserts += 1000;
        else if (typeof request === 'object')
          for (const entities of request.entitiesByWorld) upserts += entities?.size ?? 0;
        return extractFrames([world], 0, assets, caches, {
          cull: 'none',
          renderables: request,
        });
      },
      [lease],
    );
  };
  try {
    const initial = draw();
    const before = scene.shadowCasterProjection();
    const source = before?.renderables.at(0);
    if (source === undefined || before === undefined) throw new Error('missing source');
    expect(initial.renderables.at(0)?.materials[0]?.snapshot.materialHandle).toBe(red);
    expect(
      new Set(scene.compositionSlots().map((slot) => slot.snapshot.materialOverrides)).size,
    ).toBe(1);
    upserts = 0;
    assets
      .update(mesh, {
        materialSlots: [
          { slotName: 'first', defaultMaterial: green },
          { slotName: 'second', defaultMaterial: red },
        ],
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 18,
            vertexCount: 24,
            topology: 'triangle-list',
            materialSlot: 0,
          },
          {
            indexOffset: 18,
            indexCount: 18,
            vertexCount: 24,
            topology: 'triangle-list',
            materialSlot: 1,
          },
        ],
      })
      .unwrap();
    const current = draw();
    expect(upserts).toBe(0);
    expect(current.renderables).toHaveLength(1000);
    const materials = current.renderables.at(0)?.materials;
    expect(materials?.map((material) => material.snapshot.materialHandle)).toEqual([green, blue]);
    expect(new Set(current.renderables.map((row) => row.materials)).size).toBe(1);
    expect(current.renderables.at(0)?.gpuDrivenDraws).toHaveLength(2);
    expect(
      meshDrawSnapshot(source, before.content.meshes).materials[0]?.snapshot.materialHandle,
    ).toBe(red);
    assets.update(green, { values: { baseColor: [1, 1, 0, 1] } }).unwrap();
    const changed = draw();
    expect(upserts).toBe(0);
    const material = changed.renderables.at(0)?.materials[0];
    const frame = scene.shadowCasterProjection()?.content.materials;
    expect(material && frame?.get(material)?.snapshot.baseColor).toEqual(
      new Float32Array([1, 1, 0]),
    );
  } finally {
    publisher.dispose();
    receiver.dispose();
    scene.dispose();
    lease.dispose();
    assets.dispose();
  }
});
