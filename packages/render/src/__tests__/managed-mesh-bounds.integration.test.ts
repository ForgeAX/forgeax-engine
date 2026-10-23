import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

it.each([
  false,
  true,
])('adopts shared mesh bounds without entity extraction or publication (worker=%s)', (worker) => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const mesh = assets.create(BUILTIN_CUBE).unwrap();
  const material = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1 } },
    )
    .unwrap();
  for (let i = 0; i < 1000; i++)
    world
      .spawn(
        { component: Transform, data: { pos: [100, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const scene = new PersistentRenderScene({ assets });
  const caches = scene.materialSnapshotCacheStore();
  const lease = createRenderReadLease(world);
  const identity = { source: 'mesh-bounds', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  let work = 0;
  const draw = () => {
    world.update(0).unwrap();
    if (worker) {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet);
      candidate.accept();
      work += packet.upserts.length;
      const frame = scene.consumePublication(receiver.accept(packet).unwrap());
      publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      return frame;
    }
    return scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) => {
        if (request === 'full') work += 1000;
        else if (typeof request === 'object')
          for (const entities of request.entitiesByWorld) work += entities?.size ?? 0;
        return extractFrames([world], 0, assets, caches, {
          cull: 'none',
          retainHidden: true,
          renderables: request,
        });
      },
      [lease],
    );
  };
  try {
    expect(draw().renderables).toHaveLength(0);
    const before = scene.shadowCasterProjection();
    const original = before?.renderables.at(0);
    assert(original);
    const originalSlot = scene.compositionSlot(0, original.entityKey);
    assert(originalSlot);
    work = 0;
    const topologyBefore = scene.inspect().topology;
    assert(topologyBefore.contentPatches !== undefined);
    assets
      .writeRange(mesh, { attribute: 'position', first: 0, values: new Float32Array([-100, 0, 0]) })
      .unwrap();
    expect(draw().renderables).toHaveLength(1000);
    expect(work).toBe(0);
    // A same-handle content patch keeps draw facts: no topology revision or patch.
    const topologyAfter = scene.inspect().topology;
    expect(topologyAfter.revision).toBe(topologyBefore.revision);
    expect(topologyAfter.patches).toBe(topologyBefore.patches);
    expect(topologyAfter.contentPatches).toBe(topologyBefore.contentPatches + 1);
    // Draw facts capture a new Mesh root; author records keep their physical address.
    expect(scene.shadowCasterProjection()?.renderables).not.toBe(before?.renderables);
    expect(scene.compositionSlot(0, original.entityKey)).toBe(originalSlot);
    expect(before?.renderables.at(0)).toBe(original);
    expect(original.localAabb?.[0]).toBeGreaterThan(-1);
    expect(scene.shadowCasterProjection()?.renderables.at(0)?.localAabb?.[0]).toBe(-100);
    expect(original && readBounds(before, original)?.min[0]).toBeGreaterThan(99);
    expect(original && readBounds(scene.shadowCasterProjection(), original)?.min[0]).toBe(0);
  } finally {
    publisher.dispose();
    receiver.dispose();
    scene.dispose();
    lease.dispose();
    assets.dispose();
  }
});

function readBounds(
  projection: ReturnType<PersistentRenderScene['shadowCasterProjection']>,
  source: import('../render-system-extract').RenderableSnapshot,
) {
  const out = box3.create();
  return projection?.worldBoundsOf(source, out)
    ? { min: [out[0], out[1], out[2]], max: [out[3], out[4], out[5]] }
    : undefined;
}
