import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Disabled, defineSystem, type EntityHandle, Update, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import {
  ChildOf,
  Children,
  GlobalTransform,
  MorphWeights,
  Name,
  Transform,
  worldApplyMountOverride,
  worldResolveSceneAsset,
} from '@forgeax/engine-scene';
import {
  captureSceneSourceGuard,
  prepareSceneTransformsSteps,
  retainSceneSourceReferences,
  type SceneInstantiationContext,
  worldInstantiateSceneSteps,
} from '@forgeax/engine-scene/internal';
import { type AssetHandle, ok, type SceneAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Instances,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
  ShadowParticipation,
  Visibility,
  VisibilityStateValue,
} from '../components';
import { InstanceProjectionStore } from '../instances';
import { materialResource } from '../material-resource';
import { Materials } from '../materials';
import { prepareExtractContext } from '../render-system-extract';
import { extractSource } from '../render-system-extract-tail';
import { type MeshSourcePreparation, prepareMeshSourceSteps } from '../scene/prepared-mesh-source';
import { RenderScene } from '../scene/render-scene';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function finish<T>(task: Generator<void, T>): T {
  for (let index = 0; index < 10000; index++) {
    const next = task.next();
    if (next.done) return next.value;
  }
  throw new Error('Mesh source preparation did not terminate');
}

function fixture() {
  const assets = new AssetRegistry(),
    world = new World({ assets });
  cleanups.push(() => assets.dispose());
  const vocabulary = [
    Disabled,
    Transform,
    ChildOf,
    Children,
    Name,
    MeshFilter,
    MeshRenderer,
    Instances,
    SceneInstance,
    Visibility,
    ShadowParticipation,
  ];
  for (const component of vocabulary) world.components.register(component).unwrap();
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const scene = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: {
        visible: {
          components: {
            Transform: { pos: [3, 0, 0] },
            MeshFilter: { assetHandle: mesh },
            MeshRenderer: {},
          },
        },
        hidden: {
          components: {
            Transform: { pos: [6, 0, 0] },
            MeshFilter: { assetHandle: mesh },
            MeshRenderer: {},
            Visibility: { state: VisibilityStateValue.hidden },
            ShadowParticipation: { cast: false },
          },
        },
        disabled: {
          components: {
            Transform: {},
            MeshFilter: { assetHandle: mesh },
            MeshRenderer: {},
            Disabled: {},
          },
        },
      },
    })
    .unwrap();
  const members: EntityHandle[] = [],
    authorDisabled = new Set<EntityHandle>();
  const context: SceneInstantiationContext = {
    incremental: true,
    resolveAsset: (handle) => worldResolveSceneAsset(world, handle),
    resolveSource: (source) => ok(source as AssetHandle<'scene'>),
    retainSource: (asset) => retainSceneSourceReferences(world, asset),
    applyOverride: (entity, change) => worldApplyMountOverride(world, entity, change),
    materialize: (components) => {
      const authored = components.some(({ component }) => component === Disabled);
      const result = world.spawn(
        ...components,
        ...(authored ? [] : [{ component: Disabled, data: {} }]),
      );
      if (result.ok) {
        members.push(result.value);
        if (authored) authorDisabled.add(result.value);
      }
      return result;
    },
  };
  finish(worldInstantiateSceneSteps(world, scene, context)).unwrap();
  finish(
    prepareSceneTransformsSteps(world, { members, authorDisabled, isCurrent: () => true }),
  ).unwrap();
  const guard = captureSceneSourceGuard(world, members, [...vocabulary, GlobalTransform]).unwrap();
  cleanups.push(guard.dispose);
  const input: MeshSourcePreparation = { members, authorDisabled, isCurrent: guard.isCurrent };
  const extract = prepareExtractContext(world, { assets, cull: 'none', retainHidden: true });
  const prepare = (value = input) => finish(prepareMeshSourceSteps(world, extract, value));
  return { assets, world, mesh, members, input, extract, prepare };
}

describe('inactive Scene mesh source preparation', () => {
  it('extracts real disabled Scene members without enabling them or extracting the environment', () => {
    const f = fixture();
    expect(extractSource(f.world).renderables).toHaveLength(0);
    const query = vi.spyOn(f.world, 'query');
    const prepared = f.prepare().unwrap();
    expect(query).not.toHaveBeenCalled();
    expect(prepared.world).toBe(f.world);
    expect(prepared.renderables).toHaveLength(2);
    expect(prepared.renderables.map((row) => row.transform.world[12]).sort()).toEqual([3, 6]);
    expect(prepared.hiddenEntities.size).toBe(1);
    for (const entity of f.members) expect(f.world.hasComponent(entity, Disabled)).toBe(true);
    for (const entry of prepared.dispatch)
      expect(prepared.renderables[entry.renderableIndex]?.entityKey).toBe(entry.entityIndex);
    expect(prepared.isCurrent()).toBe(true);
  });

  it('uses the existing SceneRows identity and slot on ordinary activation', () => {
    const f = fixture(),
      prepared = f.prepare().unwrap(),
      scene = new RenderScene();
    scene.apply(
      prepared.renderables.map((snapshot) => ({
        kind: 'update',
        entityKey: snapshot.entityKey,
        snapshot,
      })),
    );
    const slots = prepared.renderables.map((snapshot) => scene.slot(snapshot.entityKey)?.slot);
    for (const entity of f.members)
      if (!f.input.authorDisabled.has(entity)) f.world.removeComponent(entity, Disabled).unwrap();
    const active = extractSource(f.world, f.assets, undefined, {
      cull: 'none',
      retainHidden: true,
    });
    scene.apply(
      active.renderables.map((snapshot) => ({
        kind: 'update',
        entityKey: snapshot.entityKey,
        snapshot,
      })),
    );
    expect(active.renderables).toHaveLength(2);
    expect(active.renderables.map((snapshot) => scene.slot(snapshot.entityKey)?.slot)).toEqual(
      slots,
    );
    expect(scene.slotsSnapshot()).toHaveLength(2);
    expect(prepared.isCurrent()).toBe(false);
  });

  it('owns pose and Instances values across subsequent source writes', () => {
    const f = fixture(),
      entity = f.members.find(
        (member) =>
          f.world.hasComponent(member, MeshRenderer) && !f.input.authorDisabled.has(member),
      );
    if (entity === undefined) throw new Error('Missing fixture mesh');
    const matrix = mat4.identity(mat4.create());
    f.world.addComponent(entity, { component: Instances, data: { transforms: matrix } }).unwrap();
    const guard = captureSceneSourceGuard(f.world, f.members, [
      Transform,
      Instances,
      MeshRenderer,
      MeshFilter,
    ]).unwrap();
    cleanups.push(guard.dispose);
    const prepared = f.prepare({ ...f.input, isCurrent: guard.isCurrent }).unwrap();
    const row = prepared.renderables.find((snapshot) => snapshot.entityKey === entity);
    const poses = Array.from(row?.transform.world ?? []),
      transforms = Array.from(row?.instances?.transforms ?? []);
    matrix[12] = 9;
    f.world.set(entity, Instances, { transforms: matrix }).unwrap();
    f.world.set(entity, Transform, { pos: [15, 0, 0] }).unwrap();
    expect(Array.from(row?.transform.world ?? [])).toEqual(poses);
    expect(Array.from(row?.instances?.transforms ?? [])).toEqual(transforms);
    expect(transforms).toHaveLength(16);
    expect(prepared.isCurrent()).toBe(false);
  });

  it('does not seal after an earlier member changes between continuations', () => {
    const f = fixture(),
      task = prepareMeshSourceSteps(f.world, f.extract, f.input);
    expect(task.next().done).toBe(false);
    f.world.set(f.members[0] as EntityHandle, Transform, { pos: [99, 0, 0] }).unwrap();
    expect(finish(task)).toMatchObject({ ok: false, error: { detail: { reason: 'stale-input' } } });
  });

  it('captures visibility at preparation start instead of reusing an older extract context', () => {
    const f = fixture();
    const entity = f.members.find(
      (member) =>
        f.world.hasComponent(member, MeshRenderer) &&
        !f.input.authorDisabled.has(member) &&
        !f.world.hasComponent(member, Visibility),
    );
    if (entity === undefined) throw new Error('Missing visible fixture mesh');
    f.world
      .addComponent(entity, { component: Visibility, data: { state: VisibilityStateValue.hidden } })
      .unwrap();
    const guard = captureSceneSourceGuard(f.world, f.members, [
      Transform,
      GlobalTransform,
      Visibility,
      ChildOf,
      MeshFilter,
      MeshRenderer,
    ]).unwrap();
    cleanups.push(guard.dispose);
    const prepared = f.prepare({ ...f.input, isCurrent: guard.isCurrent }).unwrap();
    expect(prepared.isCurrent()).toBe(true);
    expect(prepared.hiddenEntities.has(entity)).toBe(true);
    expect(prepared.renderables.find((row) => row.entityKey === entity)?.authorVisible).toBe(false);
  });

  it('keeps a sealed result invalid after its input guard fails once', () => {
    const f = fixture();
    let current = true;
    const prepared = f.prepare({ ...f.input, isCurrent: () => current }).unwrap();
    current = false;
    expect(prepared.isCurrent()).toBe(false);
    current = true;
    expect(prepared.isCurrent()).toBe(false);
  });

  it('checks World health after the input guard callback', () => {
    const f = fixture();
    f.world
      .addSystem(
        Update,
        defineSystem({
          name: 'prepare-guard-fault',
          queries: [],
          fn: () => {
            throw new Error('guard fault');
          },
        }),
      )
      .unwrap();
    const result = f.prepare({
      members: [],
      authorDisabled: new Set(),
      isCurrent: () => {
        f.world.update(0);
        return true;
      },
    });
    expect(f.world.execution.health).toBe('poisoned');
    expect(result).toMatchObject({ ok: false, error: { detail: { reason: 'stale-input' } } });
  });

  it('ignores the ordinary temporary MeshFilter preparation overlay', () => {
    const f = fixture();
    const entity = f.members.find(
      (member) => f.world.hasComponent(member, MeshRenderer) && !f.input.authorDisabled.has(member),
    );
    if (entity === undefined) throw new Error('Missing fixture mesh');
    const mesh = createPrimitiveMesh('cube').unwrap(),
      other = f.assets.create(mesh).unwrap();
    const context = { ...f.extract, preparationMesh: { entity, meshHandle: other, mesh } };
    const prepared = finish(prepareMeshSourceSteps(f.world, context, f.input)).unwrap();
    expect(prepared.renderables.find((row) => row.entityKey === entity)?.assetHandle).toBe(f.mesh);
  });

  it('copies Instances rather than retaining the ordinary r+2 projection buffers', () => {
    const f = fixture();
    const entity = f.members.find(
      (member) => f.world.hasComponent(member, MeshRenderer) && !f.input.authorDisabled.has(member),
    );
    if (entity === undefined) throw new Error('Missing fixture mesh');
    const matrix = mat4.identity(mat4.create());
    f.world.addComponent(entity, { component: Instances, data: { transforms: matrix } }).unwrap();
    const store = new InstanceProjectionStore(),
      project = vi.spyOn(store, 'project');
    const prepared = finish(
      prepareMeshSourceSteps(
        f.world,
        { ...f.extract, instanceCollections: store },
        { ...f.input, isCurrent: () => true },
      ),
    ).unwrap();
    const transforms = prepared.renderables.find((row) => row.entityKey === entity)?.instances
      ?.transforms;
    const instances = prepared.renderables.find((row) => row.entityKey === entity)?.instances;
    if (instances === undefined) throw new Error('Missing fixture Instances');
    store.accept(f.world, entity, instances);
    expect(transforms).toBeDefined();
    for (let revision = 0; revision < 4; revision++) {
      matrix[12] = revision + 10;
      const projected = store.project(f.world, entity, matrix);
      if (projected instanceof Error) throw projected;
      store.accept(f.world, entity, projected);
    }
    expect(transforms?.[12]).toBe(0);
    expect(project.mock.calls).toHaveLength(4);
    expect(
      prepared.renderables.find((row) => row.entityKey === entity)?.instances?.collectionId,
    ).toBeUndefined();
  });

  it('keeps candidate material adoption out of the ordinary source cache', () => {
    const f = fixture(),
      material = f.assets.create(Materials.standard({ baseColor: '#ffffff' })).unwrap();
    const entity = f.members.find(
      (member) => f.world.hasComponent(member, MeshRenderer) && !f.input.authorDisabled.has(member),
    );
    if (entity === undefined) throw new Error('Missing fixture mesh');
    f.world.set(entity, MeshRenderer, { materials: [material] }).unwrap();
    for (const member of f.members)
      if (!f.input.authorDisabled.has(member)) f.world.removeComponent(member, Disabled).unwrap();
    extractSource(f.world, f.assets, f.extract.materialSnapshotContexts, {
      cull: 'none',
      retainHidden: true,
    });
    const contexts = f.extract.materialSnapshotContexts;
    expect(contexts.size).toBeGreaterThan(0);
    const prior = Array.from(contexts, ([key, entries]) => [key, Array.from(entries.cache)]);
    const resources = Array.from(contexts.values())
      .flatMap(({ cache }) =>
        Array.from(cache.values(), ({ snapshot }) => materialResource(snapshot)),
      )
      .filter((resource) => resource !== undefined);
    const snapshots = resources.map((resource) => resource.snapshot);
    expect(snapshots.length).toBeGreaterThan(0);
    for (const member of f.members)
      if (!f.input.authorDisabled.has(member))
        f.world.addComponent(member, { component: Disabled, data: {} }).unwrap();
    f.assets.update(material, { values: { roughness: 0.25 } }).unwrap();
    f.prepare({ ...f.input, isCurrent: () => true }).unwrap();
    resources.forEach((resource, index) => {
      expect(resource.snapshot).toBe(snapshots[index]);
    });
    expect(Array.from(contexts, ([key, entries]) => [key, Array.from(entries.cache)])).toEqual(
      prior,
    );
  });

  it('returns extraction errors instead of sealing a silently skipped member', () => {
    const f = fixture();
    const entity = f.members.find(
      (member) => f.world.hasComponent(member, MeshRenderer) && !f.input.authorDisabled.has(member),
    );
    if (entity === undefined) throw new Error('Missing fixture mesh');
    f.world
      .addComponent(entity, { component: Instances, data: { transforms: new Float32Array(15) } })
      .unwrap();
    const result = f.prepare({ ...f.input, isCurrent: () => true });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'instance-transforms-stride-mismatch' },
    });
  });

  it('rejects unsupported deformation and stale entity generations', () => {
    const f = fixture(),
      entity = f.members[0] as EntityHandle;
    f.world.addComponent(entity, { component: MorphWeights, data: { weights: [1] } }).unwrap();
    expect(f.prepare({ ...f.input, isCurrent: () => true })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'unsupported-component' } },
    });
    f.world.despawn(entity).unwrap();
    f.world.spawn({ component: Transform, data: {} }, { component: Disabled, data: {} }).unwrap();
    expect(f.prepare({ ...f.input, isCurrent: () => true })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'missing-member', entity } },
    });
  });

  it('rejects duplicate, foreign author-disabled and enabled rosters', () => {
    const f = fixture(),
      entity = f.members[0] as EntityHandle;
    expect(f.prepare({ ...f.input, members: [entity, entity] })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'duplicate-member' } },
    });
    expect(f.prepare({ ...f.input, members: [], authorDisabled: new Set([entity]) })).toMatchObject(
      { ok: false, error: { detail: { reason: 'author-disabled-outside-roster' } } },
    );
    f.world.removeComponent(entity, Disabled).unwrap();
    expect(f.prepare({ ...f.input, isCurrent: () => true })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'enabled-member' } },
    });
  });
});
