import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { DEFAULT_UNLIT_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { assert, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { perspective } from '../components/camera';
import { Tilemap, TilemapSort } from '../components/tilemap';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';
import { tilemapGeometry } from '../tilemap-geometry';

it.each([
  'local',
  'worker',
] as const)('adopts Tileset content without rewriting maps or cells (%s)', (mode) => {
  const assets = new AssetRegistry();
  assets.shaderRegistry.installMaterialArtifact('forgeax::default-unlit', {
    source: 'fn main() {}',
    paramSchema: DEFAULT_UNLIT_PARAM_SCHEMA,
  });
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const atlas = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(8).fill(255),
    })
    .unwrap();
  const tileset = assets
    .create({
      kind: 'tileset',
      atlases: [atlas],
      tileWidth: 1,
      tileHeight: 1,
      columns: 2,
      rows: 1,
      regions: [{ x: 0, y: 0, width: 1, height: 1 }],
      tiles: [{ regionIndex: 0 }],
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0.5, 0.5, 5] } },
      { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
    )
    .unwrap();
  const maps = Array.from({ length: 64 }, () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Tilemap, data: { tileset, cols: 2, rows: 1, tiles: [1, 1], chunkSize: 1 } },
      )
      .unwrap(),
  );
  const lease = createRenderReadLease(world);
  const scene = new PersistentRenderScene({ assets });
  const identity = { source: 'tilemap-test', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  let extractions = 0,
    upserts = 0;
  const draw = () => {
    world.update(0).unwrap();
    if (mode === 'worker') {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet);
      candidate.accept();
      upserts += packet.upserts.length;
      const result = scene.consumePublication(
        receiver.accept(encodeRenderPublication(packet)).unwrap(),
      );
      publisher
        .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
        .unwrap();
      return result;
    }
    return scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) => {
        if (typeof request === 'object')
          for (const entities of request.entitiesByWorld) extractions += entities?.size ?? 0;
        else if (request === 'full') extractions += maps.length;
        return extractFrames(
          [world],
          { cameraOwner: 0, resourceOwner: 0 },
          assets,
          scene.materialSnapshotCacheStore(),
          {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          },
        );
      },
      [lease],
    );
  };
  try {
    draw();
    const before = draw();
    expect(before.renderables).toHaveLength(128);
    const first = before.renderables.at(0);
    assert(first?.generatedMesh);
    const vertices = first.generatedMesh.vertices.slice();
    expect(new Set(before.renderables.map((row) => row.material)).size).toBe(1);
    expect(
      maps.every(
        (entity) =>
          !world.hasComponent(entity, MeshFilter) && !world.hasComponent(entity, MeshRenderer),
      ),
    ).toBe(true);
    expect([...world.query({ read: [Transform] }).unwrap()]).toHaveLength(maps.length + 1);
    extractions = 0;
    upserts = 0;
    assets.update(tileset, { tiles: [{ regionIndex: 0, widthCells: 2 }] }).unwrap();
    const after = draw();
    expect(extractions).toBe(0);
    expect(upserts).toBe(0);
    expect(after.renderables.at(0)?.generatedMesh).not.toBe(first.generatedMesh);
    expect(first.generatedMesh.vertices).toEqual(vertices);
    expect(after.renderables.at(0)?.localAabb?.[3]).toBeGreaterThan(first.localAabb?.[3] ?? 0);
    const retained = after.renderables.at(2)?.generatedMesh;
    world
      .set(maps[0] as (typeof maps)[number], Tilemap, {
        tiles: [0, 1],
        sortScope: TilemapSort.perCell,
      })
      .unwrap();
    const changed = draw();
    expect(changed.renderables).toHaveLength(127);
    expect(changed.renderables.some((row) => row.generatedMesh === retained)).toBe(true);
    expect(tilemapGeometry(world, maps[0] as (typeof maps)[number])?.indices).toHaveLength(6);
    const observer = runtimeAssets(assets).observe().unwrap();
    observer.read().unwrap().accept();
    draw();
    expect(observer.read().unwrap().changes).toHaveLength(0);
    observer.dispose();
  } finally {
    scene.dispose();
    publisher.dispose();
    receiver.dispose();
    lease.dispose();
    assets.dispose();
  }
});
