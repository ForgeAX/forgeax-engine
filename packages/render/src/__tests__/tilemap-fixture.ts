import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { DEFAULT_UNLIT_PARAM_SCHEMA } from '@forgeax/engine-shader';
import type { TilesetAsset } from '@forgeax/engine-types';
import { CAMERA_PROJECTION_ORTHOGRAPHIC, Camera } from '../components';
import { Tilemap } from '../components/tilemap';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

export function tilemapFixture(
  options: {
    cols?: number;
    rows?: number;
    tiles?: Uint32Array;
    chunkSize?: number;
    sortScope?: number;
    tileset?: Partial<TilesetAsset>;
  } = {},
) {
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
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      shape: { viewDimension: '2d', extent: { width: 32, height: 32 } },
      data: new Uint8Array(32 * 32 * 4).fill(255),
    })
    .unwrap();
  const tileset = assets
    .create({
      kind: 'tileset',
      atlases: [atlas],
      tileWidth: 16,
      tileHeight: 16,
      columns: 2,
      rows: 2,
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 0 }],
      ...options.tileset,
    })
    .unwrap();
  const cols = options.cols ?? 2,
    rows = options.rows ?? 2;
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Tilemap,
        data: {
          tileset,
          cols,
          rows,
          tiles: options.tiles ?? new Uint32Array(cols * rows).fill(1),
          chunkSize: options.chunkSize ?? 16,
          sortScope: options.sortScope ?? 0,
        },
      },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [cols / 2, rows / 2, 100] } },
      {
        component: Camera,
        data: {
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -cols,
          right: cols,
          bottom: -rows,
          top: rows,
          near: 0.1,
          far: 200,
        },
      },
    )
    .unwrap();
  const scene = new PersistentRenderScene({ assets }),
    lease = createRenderReadLease(world),
    owners = { cameraOwner: 0, resourceOwner: 0 };
  const draw = () => {
    world.update(0).unwrap();
    return scene.extractComposition(
      [world],
      owners,
      assets,
      (request) =>
        extractFrames([world], owners, assets, scene.materialSnapshotCacheStore(), {
          cull: 'none',
          retainHidden: true,
          renderables: request,
        }),
      [lease],
    );
  };
  const dispose = () => {
    scene.dispose();
    lease.dispose();
    assets.dispose();
  };
  return { assets, world, atlas, tileset, entity, camera, scene, draw, dispose };
}
