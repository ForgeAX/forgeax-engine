import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Disabled, defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { buildMeshCollision, createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import {
  Instances,
  Layer,
  Materials,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
  ShadowParticipation,
  Visibility,
} from '@forgeax/engine-render';
import {
  ChildOf,
  Children,
  Mobility,
  MobilityKindValue,
  Name,
  Transform,
  worldApplyMountOverride,
} from '@forgeax/engine-scene';
import {
  captureSceneSourceGuard,
  createSceneRetirement,
  retainSceneSourceReferences,
  type SceneInstantiationContext,
  worldInstantiateSceneSteps,
} from '@forgeax/engine-scene/internal';
import {
  type AssetHandle,
  type ComponentValuesMap,
  err,
  ok,
  type SceneAsset,
} from '@forgeax/engine-types';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import {
  LEVEL_STREAMING_SOURCE_COMPONENTS,
  preflightLevelRosterSteps,
  preflightLevelVocabularySteps,
} from '../levels/source-preflight';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});
function finish<T>(steps: Generator<void, T>): T {
  for (let i = 0; i < 100_000; i++) {
    const next = steps.next();
    if (next.done) return next.value;
  }
  throw new Error('source preparation did not terminate');
}
const Forbidden = defineComponent('StreamUnsupportedConsumer', { value: 'f32' });
const blend: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
type SourceComponents =
  | Partial<ComponentValuesMap>
  | ((
      material: AssetHandle<'material'>,
      mesh: AssetHandle<'mesh'>,
      assets: AssetRegistry,
    ) => Partial<ComponentValuesMap>);
function fixture(extra: SourceComponents = {}, override?: SourceComponents) {
  const assets = new AssetRegistry(),
    world = new World({ assets });
  const nameLease = world.components.register(Name).unwrap();
  for (const component of [
    Disabled,
    Transform,
    ChildOf,
    Children,
    SceneInstance,
    Mobility,
    MeshFilter,
    MeshRenderer,
    Instances,
    Layer,
    ShadowParticipation,
    Visibility,
    Collider,
    RigidBody,
    Forbidden,
  ])
    world.components.register(component).unwrap();
  cleanups.push(() => assets.dispose());
  const material = assets
    .create(Materials.standard({ baseColor: '#ffffff', alphaCutoff: 0.5 }))
    .unwrap();
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const mesh = assets
    .create({
      ...geometry,
      collision: buildMeshCollision(geometry).unwrap(),
      materialSlots: [{ slotName: 'surface', defaultMaterial: material }],
    })
    .unwrap();
  const child = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: {
        block: {
          components: {
            Transform: {},
            Mobility: { kind: MobilityKindValue.static },
            MeshFilter: { assetHandle: mesh },
            MeshRenderer: { materials: [] },
            Collider: {},
            ...(typeof extra === 'function' ? extra(material, mesh, assets) : extra),
          },
        },
        spare: { components: { Transform: {}, Disabled: {} } },
      },
    })
    .unwrap();
  const root = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: {
        mount: {
          components: { Transform: {} },
          instance: {
            source: child,
            ...(override === undefined
              ? {}
              : {
                  overrides: [
                    {
                      target: ['block'],
                      components:
                        typeof override === 'function'
                          ? override(material, mesh, assets)
                          : override,
                    },
                  ],
                }),
          },
        },
      },
    })
    .unwrap();
  const lease = runtimeAssets(assets).beginContentCapture(root).unwrap().step(1000).unwrap();
  assert.isDefined(lease);
  cleanups.push(() => {
    const task = lease.retire().unwrap();
    while (!task.inspect().done) task.step(1).unwrap();
  });
  const members: EntityHandle[] = [],
    authorDisabled = new Set<EntityHandle>();
  cleanups.push(() => {
    const task = createSceneRetirement(world, members, () => true);
    while (!task.inspect().done) task.step(1).unwrap();
  });
  const context: SceneInstantiationContext = {
    incremental: true,
    resolveAsset: (handle) => {
      const value = lease.read<SceneAsset>(handle);
      return value.ok ? value : err(value.error as never);
    },
    resolveSource: (source) => ok(source as AssetHandle<'scene'>),
    retainSource: (asset) => retainSceneSourceReferences(world, asset),
    materialize: (components) => {
      const disabled = components.some(({ component }) => component === Disabled);
      const result = world.spawn(
        ...components,
        ...(disabled ? [] : [{ component: Disabled, data: {} }]),
      );
      if (result.ok) {
        members.push(result.value);
        if (disabled) authorDisabled.add(result.value);
      }
      return result;
    },
    applyOverride: (entity, change) => {
      const result = worldApplyMountOverride(world, entity, change);
      if (result.ok && change.comp === Disabled.name) authorDisabled.add(entity);
      return result;
    },
  };
  function materialize() {
    return finish(worldInstantiateSceneSteps(world, root, context)).unwrap();
  }
  function preflight() {
    const source = captureSceneSourceGuard(
      world,
      members,
      LEVEL_STREAMING_SOURCE_COMPONENTS,
    ).unwrap();
    cleanups.push(source.dispose);
    return preflightLevelRosterSteps(world, lease, {
      members,
      authorDisabled,
      isCurrent: source.isCurrent,
    });
  }
  return {
    assets,
    world,
    lease,
    root,
    child,
    members,
    authorDisabled,
    material,
    mesh,
    materialize,
    preflight,
    nameLease,
  };
}

describe('static level source preflight', () => {
  it('admits nested masked Mesh defaults and derives author-disabled participation after overrides', () => {
    const f = fixture({}, { Disabled: {} });
    expect(finish(preflightLevelVocabularySteps(f.world, f.lease)).ok).toBe(true);
    f.materialize();
    const result = finish(f.preflight()).unwrap();
    expect(f.authorDisabled.size).toBe(2);
    expect(result.effectiveMembers).toHaveLength(f.members.length - 2);
    expect(result.effectiveMembers.every((member) => !f.authorDisabled.has(member))).toBe(true);
    expect(f.members.every((member) => f.world.hasComponent(member, Disabled))).toBe(true);
  });

  it('rejects an unsupported nested component-add before the first entity is created', () => {
    const f = fixture({}, { StreamUnsupportedConsumer: { value: 1 } });
    const spawn = vi.spyOn(f.world, 'spawn');
    expect(finish(preflightLevelVocabularySteps(f.world, f.lease))).toMatchObject({
      ok: false,
      error: {
        code: 'level-source-invalid',
        detail: { reason: 'unsupported-component', component: Forbidden.name },
      },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('checks final nested RigidBody values rather than rejecting the overridden template value', () => {
    const f = fixture(
      { RigidBody: { type: RigidBodyTypeValue.dynamic } },
      { RigidBody: { type: RigidBodyTypeValue.static } },
    );
    finish(preflightLevelVocabularySteps(f.world, f.lease)).unwrap();
    f.materialize();
    expect(finish(f.preflight()).ok).toBe(true);
  });

  it('checks effective material bindings after nested overrides instead of unused template bindings', () => {
    const f = fixture(
      (_material, _mesh, assets) => ({
        MeshRenderer: {
          materials: [
            assets
              .create(Materials.standard({ baseColor: '#ffffff', renderState: { blend } }))
              .unwrap(),
          ],
        },
      }),
      (material) => ({ MeshRenderer: { materials: [material] } }),
    );
    finish(preflightLevelVocabularySteps(f.world, f.lease)).unwrap();
    f.materialize();
    expect(finish(f.preflight()).ok).toBe(true);
  });

  it('reuses qualified Mesh bindings only for the same ordered overrides', () => {
    const f = fixture();
    f.materialize();
    const repeated = f.world
      .spawn(
        { component: Disabled, data: {} },
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: f.mesh } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    f.members.push(repeated);

    const read = vi.spyOn(f.lease, 'read');
    expect(finish(f.preflight()).ok).toBe(true);
    expect(read.mock.calls.filter(([handle]) => handle === f.mesh)).toHaveLength(1);

    const uncaptured = f.assets.create(Materials.standard({ baseColor: '#467ca3' })).unwrap();
    f.world.set(repeated, MeshRenderer, { materials: [uncaptured] }).unwrap();
    expect(finish(f.preflight())).toMatchObject({
      ok: false,
      error: { detail: { reason: 'material-binding-invalid', asset: f.mesh } },
    });
  });

  it('rejects a transparent material that remains in the effective Mesh binding', () => {
    const f = fixture((_material, _mesh, assets) => ({
      MeshRenderer: {
        materials: [
          assets
            .create(Materials.standard({ baseColor: '#ffffff', renderState: { blend } }))
            .unwrap(),
        ],
      },
    }));
    f.materialize();
    expect(finish(f.preflight())).toMatchObject({
      ok: false,
      error: { detail: { reason: 'blended-material' } },
    });
  });

  it.each([
    ColliderShapeValue.cuboid,
    ColliderShapeValue.sphere,
    ColliderShapeValue.capsule,
    ColliderShapeValue.trimesh,
  ])('admits the selected static shape %s with captured Mesh geometry', (shape) => {
    const f = fixture((_material, mesh) => ({ Collider: { shape, mesh } }));
    f.materialize();
    expect(finish(f.preflight()).ok).toBe(true);
  });

  it('rejects trimesh geometry without its produced collision attachment', () => {
    const f = fixture((_material, _mesh, assets) => ({
      Collider: {
        shape: ColliderShapeValue.trimesh,
        mesh: assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap(),
      },
    }));
    f.materialize();
    expect(finish(f.preflight())).toMatchObject({
      ok: false,
      error: { detail: { reason: 'mesh-collision-not-produced' } },
    });
  });

  it('uses root material bindings for LOD geometry and ignores unused lower-detail defaults', () => {
    const f = fixture((_material, mesh, assets) => {
      const geometry = assets.read(mesh).unwrap();
      const transparent = assets
        .create(Materials.standard({ baseColor: '#ffffff', renderState: { blend } }))
        .unwrap();
      const lod = assets
        .create({
          ...geometry,
          materialSlots: [{ slotName: 'surface', defaultMaterial: transparent }],
        })
        .unwrap();
      const root = assets
        .create({ ...geometry, lods: [{ mesh: lod, screenCoverage: 0.1 }] })
        .unwrap();
      return { MeshFilter: { assetHandle: root } };
    });
    f.materialize();
    expect(finish(f.preflight()).ok).toBe(true);
  });

  it('invalidates a changed source schema during vocabulary preparation and keeps accepted proofs sticky', () => {
    const f = fixture();
    const task = preflightLevelVocabularySteps(f.world, f.lease);
    expect(task.next().done).toBe(false);
    f.nameLease.dispose().unwrap();
    const foreign = defineComponent(Name.name, { value: 'string' });
    const replacement = f.world.components.register(foreign).unwrap();
    expect(finish(task)).toMatchObject({ ok: false, error: { detail: { reason: 'stale-input' } } });
    replacement.dispose().unwrap();
    const restored = f.world.components.register(Name).unwrap();
    const guard = finish(preflightLevelVocabularySteps(f.world, f.lease)).unwrap();
    expect(guard.isCurrent()).toBe(true);
    f.world.components.register(defineComponent('UnrelatedStreamSchema', {})).unwrap();
    expect(guard.isCurrent()).toBe(true);
    restored.dispose().unwrap();
    expect(guard.isCurrent()).toBe(false);
    f.world.components.register(Name).unwrap();
    expect(guard.isCurrent()).toBe(false);
    guard.dispose();
    expect(guard.isCurrent()).toBe(false);
  });

  it.each([
    [{ RigidBody: { type: RigidBodyTypeValue.dynamic } }, 'dynamic-body'],
    [{ Collider: { isSensor: true } }, 'sensor'],
    [{ Collider: { shape: ColliderShapeValue.convexHull } }, 'unsupported-shape'],
    [{ Mobility: { kind: MobilityKindValue.movable } }, 'movable-member'],
  ] as const)('rejects unsupported final source values %#', (extra, reason) => {
    const f = fixture(extra);
    f.materialize();
    expect(finish(f.preflight())).toMatchObject({ ok: false, error: { detail: { reason } } });
  });

  it('rejects an external source edit on the next preparation quantum', () => {
    const f = fixture();
    f.materialize();
    const task = f.preflight();
    expect(task.next().done).toBe(false);
    const entity = f.members.find((member) => f.world.hasComponent(member, MeshRenderer));
    if (entity === undefined) throw new Error('missing renderable');
    f.world.set(entity, MeshRenderer, { materials: [f.material] }).unwrap();
    expect(finish(task)).toMatchObject({ ok: false, error: { detail: { reason: 'stale-input' } } });
  });

  it('rejects enabled partial ownership and a foreign author-disabled member', () => {
    const f = fixture();
    f.materialize();
    const entity = f.members[0];
    if (entity === undefined) throw new Error('missing member');
    f.world.removeComponent(entity, Disabled).unwrap();
    expect(finish(f.preflight())).toMatchObject({
      ok: false,
      error: { detail: { reason: 'enabled-member' } },
    });
    f.world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
    f.authorDisabled.add(123 as EntityHandle);
    expect(finish(f.preflight())).toMatchObject({
      ok: false,
      error: { detail: { reason: 'author-disabled-outside-roster' } },
    });
  });
});
