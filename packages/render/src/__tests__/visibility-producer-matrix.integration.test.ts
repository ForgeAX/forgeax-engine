import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { ChildOf, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { DEFAULT_UNLIT_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import type { TilesetAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Instances } from '../components/instances';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { SpriteInstances } from '../components/sprite-instances';
import { Tilemap } from '../components/tilemap';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';
import { classifySceneDataCoverage } from '../temporal/coverage';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();
const BUILTIN_QUAD = createPrimitiveMesh('quad').unwrap();

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type ProducerCase = {
  readonly name: string;
  readonly setup: (world: World, assets: AssetRegistry) => EntityHandle;
};

function staticMesh(world: World, assets: AssetRegistry): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function skinnedMesh(world: World, assets: AssetRegistry): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: {} },
      {
        component: Skin,
        data: {
          skeleton: assets
            .create({ kind: 'skeleton', jointCount: 0, inverseBindMatrices: new Float32Array(0) })
            .unwrap(),
          joints: [],
        },
      },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function spriteMesh(world: World, assets: AssetRegistry): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_QUAD).unwrap() } },
      { component: MeshRenderer, data: {} },
      {
        component: SpriteInstances,
        data: { transforms: IDENTITY, regions: new Float32Array([0, 0, 1, 1]) },
      },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function autoFoldInstances(world: World, assets: AssetRegistry): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: IDENTITY } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function explicitInstances(world: World, assets: AssetRegistry): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: IDENTITY } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function tilemap(world: World, assets: AssetRegistry): EntityHandle {
  const tileset: TilesetAsset = {
    kind: 'tileset',
    atlases: [
      assets
        .create({
          kind: 'texture',
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
          shape: { viewDimension: '2d', extent: { width: 16, height: 16 } },
          data: new Uint8Array(16 * 16 * 4).fill(255),
        })
        .unwrap(),
    ],
    tileWidth: 16,
    tileHeight: 16,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
  const handle = assets.create(tileset).unwrap();
  const map = world
    .spawn(
      { component: Tilemap, data: { cols: 1, rows: 1, tileset: handle, tiles: [1] } },
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  return map;
}

const PRODUCERS: readonly ProducerCase[] = [
  { name: 'static mesh', setup: staticMesh },
  { name: 'skinned mesh', setup: skinnedMesh },
  { name: 'sprite', setup: spriteMesh },
  { name: 'auto-fold Instances', setup: autoFoldInstances },
  { name: 'explicit Instances', setup: explicitInstances },
  { name: 'tilemap', setup: tilemap },
];

describe('visibility built-in producer matrix', () => {
  it('records visibility reentry as a bounded reactive contributor', () => {
    const coverage = classifySceneDataCoverage({
      contributors: [{ id: 'visibility-reentry', kind: 'reactive' }],
      requiredContributorIds: ['visibility-reentry'],
    });
    expect(coverage.complete).toBe(true);
    expect(coverage.reactiveContributorIds).toEqual(['visibility-reentry']);
  });

  it.each(PRODUCERS)('$name is hidden, visible, then restorable', ({ setup }) => {
    const assets = new AssetRegistry();
    assets.shaderRegistry.installMaterialArtifact('forgeax::default-unlit', {
      source: 'fn main() {}',
      paramSchema: DEFAULT_UNLIT_PARAM_SCHEMA,
    });
    const world = new World({ assets });
    registerPropagateTransforms(world);
    const entity = setup(world, assets);
    world.update(0).unwrap();

    const hidden = extractFrames([world], { cameraOwner: 0, resourceOwner: 0 }, assets);
    expect(hidden.renderables).toHaveLength(0);
    expect(hidden.dispatch).toHaveLength(0);

    world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const visible = extractFrames([world], { cameraOwner: 0, resourceOwner: 0 }, assets);
    expect(visible.visibilitySnapshots[0]?.get(entity)?.effective).toBe('visible');

    world.set(entity, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    const restored = extractFrames([world], { cameraOwner: 0, resourceOwner: 0 }, assets);
    expect(restored.renderables).toHaveLength(0);
    expect(restored.dispatch).toHaveLength(0);
  });
});

it.each([
  'self',
  'parent',
] as const)('removes %s-hidden casters from the retained shadow projection and restores them', (hiddenBy) => {
  const assets = new AssetRegistry();
  assets.shaderRegistry.installMaterialArtifact('forgeax::default-unlit', {
    source: 'fn main() {}',
    paramSchema: DEFAULT_UNLIT_PARAM_SCHEMA,
  });
  const world = new World({ assets });
  registerPropagateTransforms(world);
  registerPropagateTransforms(world);
  const parent = world
    .spawn(
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent } },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: {} },
      {
        component: Visibility,
        data: {
          state:
            hiddenBy === 'self' ? VisibilityStateValue.visible : VisibilityStateValue.inherited,
        },
      },
    )
    .unwrap();
  world.update(0).unwrap();
  const scene = new PersistentRenderScene({ assets });
  const lease = createRenderReadLease(world);
  const draw = () =>
    scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (renderables) =>
        extractFrames(
          [world],
          { cameraOwner: 0, resourceOwner: 0 },
          assets,
          undefined,
          scene.materialSnapshotCacheStore(),
          {
            cull: 'none',
            retainHidden: true,
            renderables,
          },
        ),
      [lease],
    );
  const shadowDispatch = () =>
    scene
      .shadowCasterProjection()
      ?.dispatch.filter((entry) => entry.tags.LightMode === 'ShadowCaster') ?? [];

  try {
    draw();
    expect(shadowDispatch()).toHaveLength(1);

    const visibilityOwner = hiddenBy === 'self' ? entity : parent;
    world.set(visibilityOwner, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    world.update(0).unwrap();
    expect(draw().dispatch).toHaveLength(0);
    expect(shadowDispatch()).toHaveLength(0);

    world.set(visibilityOwner, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    world.update(0).unwrap();
    draw();
    expect(shadowDispatch()).toHaveLength(1);
  } finally {
    lease.dispose();
    scene.dispose();
  }
});
