import { HANDLE_CUBE, HANDLE_QUAD, resolveTilesetRuntime } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { ChildOf, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Instances } from '../components/instances';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { SpriteInstances } from '../components/sprite-instances';
import { TileLayer } from '../components/tile-layer';
import { Tilemap } from '../components/tilemap';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';
import { classifySceneDataCoverage } from '../temporal/coverage';
import { tilemapChunkExtractSystem } from '../tilemap-chunk-extract-system';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type ProducerCase = {
  readonly name: string;
  readonly setup: (world: World) => EntityHandle;
};

function staticMesh(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function skinnedMesh(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Skin, data: { skeleton: toShared<'SkeletonAsset'>(999), joints: [] } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function spriteMesh(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: {} },
      {
        component: SpriteInstances,
        data: { transforms: IDENTITY, regions: new Float32Array([0, 0, 1, 1]) },
      },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function autoFoldInstances(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: IDENTITY } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function explicitInstances(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: IDENTITY } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function tilemap(world: World): EntityHandle {
  const tileset: TilesetAsset = {
    kind: 'tileset',
    atlases: ['visibility/atlas'],
    tileWidth: 16,
    tileHeight: 16,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
  const lookup = (guid: string) => (guid === 'test/tileset' ? tileset : undefined);
  const map = world
    .spawn(
      { component: Tilemap, data: { cols: 1, rows: 1, tileset: 'test/tileset' } },
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  world.spawn(
    { component: TileLayer, data: { tiles: new Uint32Array([1]), dirty: 0 } },
    { component: ChildOf, data: { parent: map } },
  );
  tilemapChunkExtractSystem(world, lookup);
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
    const world = new World();
    const entity = setup(world);

    const hidden = extractFrames([world], 0);
    expect(hidden.renderables).toHaveLength(0);
    expect(hidden.dispatch).toHaveLength(0);

    world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const visible = extractFrames([world], 0);
    expect(visible.visibilitySnapshots[0]?.get(entity)?.effective).toBe('visible');

    world.set(entity, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    const restored = extractFrames([world], 0);
    expect(restored.renderables).toHaveLength(0);
    expect(restored.dispatch).toHaveLength(0);
  });
});

it.each([
  'self',
  'parent',
] as const)('removes %s-hidden casters from the retained shadow projection and restores them', (hiddenBy) => {
  const world = new World();
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
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
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
  const scene = new PersistentRenderScene();
  const lease = createRenderReadLease(world);
  const draw = () =>
    scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      (renderables) =>
        extractFrames([world], 0, undefined, undefined, scene.materialSnapshotCacheStore(), {
          cull: 'none',
          retainHidden: true,
          renderables,
        }),
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

describe('tileset durable atlas projection', () => {
  it('projects the atlas GUID through the current World for the tilemap owner', () => {
    const world = new World();
    const atlas = { kind: 'texture', width: 1, height: 1 } as never;
    const first = resolveTilesetRuntime(world, 'visibility/atlas', (guid) =>
      guid === 'visibility/atlas' ? atlas : undefined,
    );
    const second = resolveTilesetRuntime(world, 'visibility/atlas', () => atlas);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.handle).toBe(second.value.handle);

    const otherWorld = new World();
    const other = resolveTilesetRuntime(otherWorld, 'visibility/atlas', () => atlas);
    expect(other.ok).toBe(true);
    if (first.ok && other.ok) {
      expect(world.sharedRefs.resolve(first.value.handle).ok).toBe(true);
      expect(otherWorld.sharedRefs.resolve(other.value.handle).ok).toBe(true);
    }
  });

  it('fails closed for stale atlas payloads', () => {
    const result = resolveTilesetRuntime(new World(), 'stale-atlas', () => ({ code: 'stale' }));
    expect(result).toMatchObject({ ok: false, error: { code: 'tileset-atlas-stale' } });
  });
});
