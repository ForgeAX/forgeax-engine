import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { Camera } from '../components';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import { worldRenderResources } from '../publication/resource-scope';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';
import { terrainDrawSection } from '../terrain/source';
import { captureSubmittedTerrain } from '../terrain/submitted';

function fixture(worker: boolean, columns = 2, rows = 2, n = 2, entities = 1) {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  registerPropagateTransforms(world);
  world.components.register(Terrain).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 100] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1 } },
    )
    .unwrap();
  const layer = assets
    .create({
      kind: 'material',
      colorSpace: 'linear',
      parameters: standardSurfaceParameters([]),
      values: { baseColor: [1, 0, 0, 1] },
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  const heights = new Float32Array(columns * rows);
  heights[heights.length - 1] = 1;
  const root = assets
    .create({
      kind: 'terrain',
      columns,
      rows,
      spacing: 1,
      subsectionVertices: n,
      heights,
      weights: new Float32Array(columns * rows).fill(1),
      layers: [{ material: layer, blend: 'weight' }],
    })
    .unwrap();
  for (let index = 0; index < entities; index++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Terrain, data: { asset: root, forcedLod: 0 } },
      )
      .unwrap();
  const scene = new PersistentRenderScene({ assets });
  const lease = createRenderReadLease(world);
  const caches = scene.materialSnapshotCacheStore();
  const identity = { source: 'managed-terrain', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  let extracted = 0,
    upserts = 0;
  const draw = () => {
    world.update(0).unwrap();
    if (worker) {
      const candidate = publisher.prepare(0).unwrap(),
        packet = structuredClone(candidate.packet);
      const heightPatch = packet.assetPatches.find((patch) => patch.handle === root);
      if (heightPatch !== undefined) {
        expect(packet.assets.some((row) => row.handle === root)).toBe(false);
        expect(heightPatch.fields).toEqual({});
        const invalid = structuredClone(packet);
        const bytes = invalid.assetPatches.find((patch) => patch.handle === root)?.ranges[0]?.bytes;
        assert(bytes);
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(0, NaN, true);
        const revision = receiver.acceptedRevision;
        expect(receiver.accept(encodeRenderPublication(invalid), assets).ok).toBe(false);
        expect(receiver.acceptedRevision).toBe(revision);
      }
      candidate.accept();
      upserts += packet.upserts.length;
      const frame = scene.consumePublication(
        receiver.accept(encodeRenderPublication(packet), assets).unwrap(),
      );
      publisher
        .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
        .unwrap();
      return frame;
    }
    return scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) => {
        if (request !== 'none') extracted++;
        return extractFrames([world], 0, assets, caches, {
          cull: 'none',
          retainHidden: true,
          renderables: request,
        });
      },
      [lease],
    );
  };
  return {
    assets,
    world,
    root,
    scene,
    draw,
    work: () => ({ extracted, upserts }),
    dispose() {
      publisher.dispose();
      receiver.dispose();
      scene.dispose();
      lease.dispose();
      assets.dispose();
    },
  };
}

it.each([
  false,
  true,
])('adopts a bound Terrain root during section execution without entity updates (worker=%s)', (worker) => {
  const f = fixture(worker);
  try {
    const before = f.draw();
    const oldSection = before.renderables.at(0)?.terrainSection;
    expect(oldSection?.source.asset.heightRange).toEqual([0, 1]);
    const work = f.work();
    f.assets.update(f.root, { heights: new Float32Array([0, 0, 0, 3]) }).unwrap();
    const after = f.draw();
    expect(after.renderables.at(0)?.terrainSection?.source.asset.heightRange).toEqual([0, 3]);
    expect(after.renderables.at(0)?.localAabb?.[4]).toBeGreaterThanOrEqual(3);
    expect(oldSection?.source.asset.heightRange).toEqual([0, 1]);
    expect(
      captureSubmittedTerrain(before.renderables, [f.world].map(worldRenderResources))[0]?.surface
        .heights,
    ).toEqual(new Uint8Array(new Float32Array([0, 0, 0, 1, 0]).buffer));
    expect(after.renderables.at(0)?.material.snapshot.paramSnapshot?.terrainLod).toEqual([
      0, 0, 1, 1,
    ]);
    expect(f.work()).toEqual(work);
  } finally {
    f.dispose();
  }
});

it.each([
  false,
  true,
])('copies only intersected Terrain tiles and preserves old submitted heights for shared instances (worker=%s)', (worker) => {
  // 8 sections packed over two physical atlas rows; all 100 instances share them.
  const f = fixture(worker, 29, 15, 8, 100);
  try {
    const before = f.draw();
    const old = before.renderables.at(0)?.terrainSection?.source;
    assert(old);
    expect(old.sectionCount).toBe(8);
    const work = f.work();
    f.scene.commitTemporalFrame().unwrap();
    // x=7 is the logical seam shared by sections 0 and 1. Its two changed rows
    // must not spill into section 4, which shares the atlas's next physical row.
    f.assets
      .writeRange(f.root, {
        origin: { x: 7, z: 2 },
        size: { columns: 1, rows: 2 },
        heights: new Float32Array([3, 4]),
      })
      .unwrap();
    const after = f.draw();
    const next = after.renderables.at(0)?.terrainSection?.source;
    assert(next);
    expect(next).not.toBe(old);
    for (let index = 0; index < 8; index++) {
      const current = terrainDrawSection(next, index);
      const previous = terrainDrawSection(old, index);
      if (index < 2) {
        expect(current).not.toBe(previous);
        expect(current.heights).not.toBe(previous.heights);
      } else expect(current).toBe(previous);
    }
    expect(
      new DataView(terrainDrawSection(next, 0).heights.buffer).getFloat32((2 * 8 + 7) * 4, true),
    ).toBe(3);
    expect(
      new DataView(terrainDrawSection(next, 1).heights.buffer).getFloat32(2 * 8 * 4, true),
    ).toBe(3);
    expect(
      new DataView(terrainDrawSection(old, 0).heights.buffer).getFloat32((2 * 8 + 7) * 4, true),
    ).toBe(0);
    const firstEntity = after.renderables.at(0)?.entityKey;
    const instance = after.renderables.filter((row) => row.entityKey === firstEntity);
    expect(
      instance.filter((row) => row.temporal?.reactive).map((row) => row.terrainSection?.index),
    ).toEqual([0, 1]);
    expect(after.renderables.every((row) => row.terrainSection?.source === next)).toBe(true);
    const oldReceipt = captureSubmittedTerrain(
      before.renderables,
      [f.world].map(worldRenderResources),
    );
    expect(oldReceipt[0]?.surface.heights).toBe(terrainDrawSection(old, 0).heights);
    expect(f.work()).toEqual(work);
  } finally {
    f.dispose();
  }
});
