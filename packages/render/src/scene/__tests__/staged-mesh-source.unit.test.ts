import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type AssetContentLease, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Disabled, Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  ChildOf,
  Children,
  Name,
  registerPropagateTransforms,
  Transform,
  worldApplyMountOverride,
  worldResolveSceneAsset,
} from '@forgeax/engine-scene';
import {
  prepareSceneRosterParticipation,
  prepareSceneTransformsSteps,
  retainSceneSourceReferences,
  type SceneInstantiationContext,
  worldInstantiateSceneSteps,
} from '@forgeax/engine-scene/internal';
import { Terrain } from '@forgeax/engine-terrain';
import { type AssetHandle, ok, type SceneAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Camera,
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
  ShadowParticipation,
  Visibility,
  VisibilityStateValue,
} from '../../components';
import { GlyphText } from '../../components/glyph-text';
import { Tilemap } from '../../components/tilemap';
import { GpuInputArena } from '../../gpu-input-arena';
import { InstanceProjectionStore } from '../../instances';
import { MaterialResource } from '../../material-resource';
import { Materials } from '../../materials';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { extractSource } from '../../render-system-extract-tail';
import { meshSourceComponents } from '../prepared-mesh-source';
import { PublishedMeshSource } from '../published-mesh-source';
import { PersistentRenderScene } from '../render-scene';
import { type PersistentRenderCandidateRequest, SceneComposition } from '../scene-composition';
import { SkinSceneInputs } from '../skin-scene-inputs';
import type { StagedMeshSource } from '../staged-mesh-source';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
it.each([
  false,
  true,
])('adopts sealed material identities once and checks distinct chunks (conflicting=%s)', (conflicting) => {
  const snapshot = {
    ...defaultMaterialSnapshot(2),
    materialContext: { geometry: 'mesh', vertexColor: false } as const,
  };
  const material = MaterialResource.from(snapshot);
  const nextMaterial = MaterialResource.from(
    structuredClone({ ...snapshot, roughness: conflicting ? 0.5 : snapshot.roughness }),
  );
  const row = (entityKey: number, resource: MaterialResource): RenderableSnapshot => ({
    entityKey,
    assetHandle: 1,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    material: resource,
    materials: [resource],
    materialBindingSources: [],
  });
  const current = () => true;
  const version = vi.fn(() => ok(1));
  const source = new PublishedMeshSource(
    {},
    {
      members: [1, 2, 3, 4],
      chunks: [
        [row(1, material), row(2, material)],
        [row(3, nextMaterial), row(4, nextMaterial)],
      ],
      content: {
        handles: [],
        matchesCurrent: current,
        version,
        read: () => {
          throw new Error('Unexpected asset read');
        },
      },
      isCurrent: current,
    },
  );
  const work = source.extract(current);
  expect(work.next().done).toBe(false);
  const second = work.next();
  if (conflicting) {
    if (!second.done) throw new Error('The conflicting chunk should fail its extraction step');
    expect(second.value).toMatchObject({ ok: false, error: { detail: { reason: 'material' } } });
  } else {
    expect(second.done).toBe(false);
    const result = work.next();
    if (!result.done) throw new Error('Each sealed chunk should take one extraction step');
    const { renderables } = result.value.unwrap();
    expect(renderables.map(({ entityKey, mobility }) => [entityKey, mobility])).toEqual([
      [1, 'static'],
      [2, 'static'],
      [3, 'static'],
      [4, 'static'],
    ]);
    for (const row of renderables) {
      expect(row.material).toBe(material);
      expect(row.materials[0]).toBe(material);
    }
  }
  expect(version).toHaveBeenCalledTimes(2);
});

function finish<T>(work: Generator<void, T>): T {
  for (let i = 0; i < 10000; i++) {
    const next = work.next();
    if (next.done) return next.value;
  }
  throw new Error('Scene fixture did not terminate');
}
function stageAll(task: StagedMeshSource): void {
  for (let i = 0; i < 10000; i++) {
    const state = task.step().unwrap();
    if (state.phase === 'resident-input') return;
  }
  throw new Error('Source admission did not terminate');
}
function retireAll(task: StagedMeshSource): void {
  for (let i = 0; i < 10000; i++) {
    if (task.retireStep().unwrap().phase === 'retired') return;
  }
  throw new Error('Source retirement did not terminate');
}
function fixture(
  withInstances: boolean | 'empty' = false,
  beforeCapture?: (world: World, entity: EntityHandle) => void,
) {
  const assets = new AssetRegistry(),
    world = new World({ assets });
  const store = new InstanceProjectionStore();
  const shared = new SceneComposition({ assets, instanceCollections: store });
  const view = new PersistentRenderScene({}, shared, false);
  const lease = createRenderReadLease(world),
    unregister = registerPropagateTransforms(world);
  for (const component of [
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
  ])
    world.components.register(component).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  const material = assets.create(Materials.standard({ baseColor: '#ffffff' })).unwrap();
  const mesh = assets
    .create({
      ...createPrimitiveMesh('cube').unwrap(),
      materialSlots: [{ slotName: 'surface', defaultMaterial: material }],
    })
    .unwrap();
  const resident = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(0).unwrap();
  const requests: PersistentRenderCandidateRequest[] = [];
  const controls: { guard?: () => void; extra?: RenderableSnapshot } = {};
  const build = (request: PersistentRenderCandidateRequest) => {
    requests.push(request);
    const frame = extractSource(world, assets, shared.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
      instanceCollections: store,
    });
    return controls.extra === undefined || typeof request !== 'object'
      ? frame
      : { ...frame, renderables: [...frame.renderables, controls.extra] };
  };
  const draw = () => view.extractComposition(world, assets, build, lease);
  draw();
  const scene = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: {
        visible: {
          components: { Transform: {}, MeshFilter: { assetHandle: mesh }, MeshRenderer: {} },
        },
        hidden: {
          components: {
            Transform: { pos: [1, 0, 0] },
            MeshFilter: { assetHandle: mesh },
            MeshRenderer: {},
            Visibility: { state: VisibilityStateValue.hidden },
            ShadowParticipation: { cast: false },
          },
        },
        authored: {
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
  const instanced = members.find(
    (entity) =>
      world.hasComponent(entity, MeshRenderer) &&
      !authorDisabled.has(entity) &&
      !world.hasComponent(entity, Visibility),
  );
  if (instanced === undefined) throw new Error('Missing visible Scene member');
  beforeCapture?.(world, instanced);
  if (withInstances)
    world
      .addComponent(instanced, {
        component: Instances,
        data: {
          transforms:
            withInstances === 'empty'
              ? new Float32Array(0)
              : new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        },
      })
      .unwrap();
  const capture = runtimeAssets(assets).beginContentCapture(scene).unwrap();
  let content: AssetContentLease | undefined;
  while (content === undefined) content = capture.step(1).unwrap();
  const fixed = content;
  const source = prepareSceneRosterParticipation(world, {
    members,
    authorDisabled,
    sourceComponents: meshSourceComponents(world),
    isCurrent: () => {
      const action = controls.guard;
      delete controls.guard;
      action?.();
      return fixed.matchesCurrent();
    },
  }).unwrap();
  cleanups.push(() => {
    for (const member of members)
      if (world.get(member, Entity).ok && !world.hasComponent(member, Disabled))
        world.addComponent(member, { component: Disabled, data: {} }).unwrap();
    source.dispose();
    view.dispose();
    shared.dispose();
    store.dispose();
    lease.dispose();
    unregister();
    const retirement = capture.retire().unwrap();
    while (!retirement.inspect().done) retirement.step(1).unwrap();
    assets.dispose();
  });
  const begin = () => shared.beginStagedGroup(source.capture().unwrap(), fixed, lease).unwrap();
  return {
    assets,
    world,
    store,
    shared,
    view,
    lease,
    source,
    begin,
    draw,
    build,
    members,
    resident,
    requests,
    mesh,
    material,
    content: fixed,
    controls,
    instanced,
  };
}

describe('real composition staged mesh source', () => {
  const unsupportedSources: [string, (world: World, entity: EntityHandle) => void][] = [
    [
      'Terrain',
      (world, entity) => {
        world.addComponent(entity, { component: Terrain, data: {} }).unwrap();
      },
    ],
    [
      'GlyphText',
      (world, entity) => {
        world.addComponent(entity, { component: GlyphText, data: {} }).unwrap();
      },
    ],
    [
      'Tilemap',
      (world, entity) => {
        world.addComponent(entity, { component: Tilemap, data: {} }).unwrap();
      },
    ],
  ];
  it.each(
    unsupportedSources,
  )('rejects unsupported %s before fulfilling a non-mesh member', (_name, install) => {
    const f = fixture(false, (world, entity) => {
      world.removeComponent(entity, MeshRenderer).unwrap();
      install(world, entity);
    });
    const task = f.begin();
    let failure: unknown;
    for (let step = 0; step < 1000; step++) {
      const result = task.step();
      if (!result.ok) {
        failure = result.error;
        break;
      }
      if (result.value.phase === 'resident-input') break;
    }
    expect(failure).toMatchObject({ cause: { detail: { reason: 'unsupported-component' } } });
    expect(task.inspect().phase).toBe('failed');
    expect(f.shared.entry?.projection.slot(f.instanced)).toBeUndefined();
  });
  it('admits the real disabled Scene into existing rows without accepting the ordinary cursor', () => {
    const f = fixture();
    const entry = f.shared.entry;
    if (entry === undefined) throw new Error('Missing actual composition');
    const version = entry.readVersion;
    const task = f.begin();
    stageAll(task);
    expect(entry.readVersion).toBe(version);
    expect(task.isCurrent()).toBe(true);
    expect(entry.projection.slotsSnapshot()).toHaveLength(3);
    expect(f.members.every((entity) => f.world.hasComponent(entity, Disabled))).toBe(true);
    expect(entry.topology.hasResidencyGroup(task.group)).toBe(true);
    for (const entity of f.members) {
      const row = entry.projection.slot(entity);
      if (row !== undefined) expect(row.snapshot.residencyGroup).toBe(task.group);
    }
    const frame = f.draw();
    expect(new Set(Array.from(frame.dispatch, (entry) => entry.entityIndex))).toEqual(
      new Set([f.resident]),
    );
    expect(entry.pendingRenderableEntities.size).toBe(0);
    expect(entry.unavailableSlots.size).toBe(0);
    retireAll(task);
    expect(entry.projection.slotsSnapshot()).toHaveLength(1);
    expect(entry.topology.hasResidencyGroup(task.group)).toBe(false);
  });

  it('publishes the closed roster removal as one Scene delta while keeping the ordinary row', () => {
    const f = fixture(true);
    const entry = f.shared.entry;
    if (entry === undefined) throw new Error('Missing actual composition');
    const task = f.begin();
    stageAll(task);
    const version = entry.readVersion;
    const owned = [...entry.projection.slotsSnapshot()]
      .filter((row) => row.snapshot.residencyGroup === task.group)
      .map((row) => ({ kind: 'remove', entityKey: row.entityKey }));
    expect(owned).toHaveLength(2);
    const apply = vi.spyOn(entry.projection, 'apply');
    try {
      expect(task.retireStep().unwrap().phase).toBe('retiring');
      expect(apply).toHaveBeenCalledExactlyOnceWith(owned);
      expect(entry.readVersion).toBe(version);
      expect([...entry.projection.slotsSnapshot()].map((row) => row.entityKey)).toEqual([
        f.resident,
      ]);
      expect(f.store._inspections(0)).toHaveLength(0);
      retireAll(task);
    } finally {
      apply.mockRestore();
    }
  });

  it('reuses the same actual source rows and canonical materials on repeated controlled transitions', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    const entry = f.shared.entry;
    if (entry === undefined) throw new Error('Missing actual composition');
    f.draw();
    const owned = entry.projection
      .slotsSnapshot()
      .filter((row) => row.snapshot.residencyGroup === task.group);
    const cached = [...f.shared.materialSnapshotCacheStore().values()]
      .find(({ cache }) => cache.has(f.material))
      ?.cache.get(f.material);
    if (cached === undefined) throw new Error('Missing actual canonical material');
    const residentMaterial = MaterialResource.from(cached.snapshot);
    expect(entry.materialDispatch.materials().get(residentMaterial)?.bindings).toBe(1);
    for (const row of owned) expect(row.snapshot.material).toBe(residentMaterial);
    for (let i = 0; i < 3; i++) {
      const active = f.source.setActive(true, f.source.capture().unwrap()).unwrap();
      task.acceptSource(active).unwrap();
      entry.topology.setResidencyGroupActive(task.group, true);
      f.requests.length = 0;
      const frame = f.draw();
      expect(new Set(Array.from(frame.dispatch, (entry) => entry.entityIndex)).size).toBe(2);
      for (const row of owned) {
        const current = entry.projection.slot(row.entityKey);
        expect(current?.slot).toBe(row.slot);
        expect(current?.generation).toBe(row.generation);
        expect(current?.snapshot.material).toBe(row.snapshot.material);
      }
      expect(
        f.requests
          .filter((request) => typeof request === 'object')
          .every((request) => !owned.some((row) => request.entities.has(row.entityKey))),
      ).toBe(true);
      const inactive = f.source.setActive(false, active).unwrap();
      task.acceptSource(inactive).unwrap();
      expect(new Set(Array.from(f.draw().dispatch, (entry) => entry.entityIndex))).toEqual(
        new Set([f.resident]),
      );
    }
    retireAll(task);
  });

  it('does not swallow a resident edit made in the same source batch as a controlled transition', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    f.draw();
    f.world.set(f.resident, Transform, { pos: [2, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const active = f.source.setActive(true, f.source.capture().unwrap()).unwrap();
    task.acceptSource(active).unwrap();
    f.draw();
    expect(f.shared.entry?.projection.slot(f.resident)?.snapshot.transform.world[12]).toBe(2);
    f.source.setActive(false, active).unwrap();
    retireAll(task);
  });

  it('does not inspect a dormant source to record an unrelated ordinary row edit', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    f.draw();
    const inspected = vi.fn();
    f.controls.guard = inspected;
    f.world.addComponent(f.resident, { component: Layer, data: { value: 7 } }).unwrap();
    f.world.set(f.resident, Transform, { pos: [2, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    f.draw();
    expect(f.shared.entry?.projection.slot(f.resident)?.snapshot.transform.world[12]).toBe(2);
    expect(inspected).not.toHaveBeenCalled();
    delete f.controls.guard;
    retireAll(task);
  });

  it('refuses BG work while the actual ordinary stage is unsettled', () => {
    const f = fixture(),
      task = f.begin();
    f.shared.extract(f.world, f.assets, f.build, f.lease);
    expect(task.step()).toMatchObject({ ok: false, error: { detail: { reason: 'busy' } } });
    expect(task.inspect().phase).toBe('extracting');
    f.draw();
    stageAll(task);
    retireAll(task);
  });

  it('refuses callback reentry into its source task without changing its qualification', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    const rows = f.shared.entry?.projection.slotsSnapshot().length;
    let nested: unknown;
    f.controls.guard = () => {
      nested = task.retireStep();
    };
    expect(task.isCurrent()).toBe(true);
    expect(nested).toMatchObject({ ok: false, error: { detail: { reason: 'busy' } } });
    expect(task.inspect().phase).toBe('resident-input');
    expect(f.shared.entry?.projection.slotsSnapshot()).toHaveLength(rows ?? -1);
    retireAll(task);
  });

  it('defers retirement without changing the execution gate while the ordinary stage is pending', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    const active = f.source.setActive(true, f.source.capture().unwrap()).unwrap();
    task.acceptSource(active).unwrap();
    const entry = f.shared.entry;
    if (entry === undefined) throw new Error('Missing actual composition');
    entry.topology.setResidencyGroupActive(task.group, true);
    f.draw();
    f.shared.extract(f.world, f.assets, f.build, f.lease);
    const selection = entry.topology.captureResidencySelection();
    expect(task.retireStep()).toMatchObject({ ok: false, error: { detail: { reason: 'busy' } } });
    expect(selection.isCurrent()).toBe(true);
    expect(task.inspect().phase).toBe('resident-input');
    f.draw();
    task.acceptSource(f.source.setActive(false, active).unwrap()).unwrap();
    retireAll(task);
  });

  it('invalidates the real staged issuer on scope disposal and retires without another frame', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    const previous = f.shared.entry;
    if (previous === undefined) throw new Error('Missing actual composition');
    const selection = previous.topology.captureResidencySelection();
    expect(() => f.shared.invalidate()).not.toThrow();
    expect(selection.isCurrent()).toBe(false);
    expect(task.isCurrent()).toBe(false);
    retireAll(task);
    expect(task.inspect().phase).toBe('retired');
  });

  it('drains its actual collection responsibilities on composition disposal without a future frame or whole-store disposal', () => {
    const f = fixture(true),
      task = f.begin();
    stageAll(task);
    expect(f.store._inspections(0)).toHaveLength(1);
    f.shared.dispose();
    expect(f.store._inspections(0)).toHaveLength(0);
    expect(task.inspect().phase).toBe('retired');
  });

  it('rejects an ordinary producer returning a managed row before changing the actual source rows', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    f.draw();
    const entry = f.shared.entry;
    const row = entry?.projection.slot(f.instanced);
    if (entry === undefined || row === undefined) throw new Error('Missing actual managed row');
    const { residencyGroup, ...ordinary } = row.snapshot;
    expect(residencyGroup).toBe(task.group);
    f.controls.extra = ordinary;
    f.world.addComponent(f.resident, { component: Layer, data: { value: 7 } }).unwrap();
    f.world.set(f.resident, Transform, { pos: [2, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    expect(() => f.draw()).toThrow('Staged mesh source: collision');
    expect(entry.projection.slot(row.entityKey)?.version).toBe(row.version);
    expect(entry.projection.slot(row.entityKey)?.snapshot.residencyGroup).toBe(task.group);
    expect(task.isCurrent()).toBe(true);
    delete f.controls.extra;
    f.draw();
    expect(entry.projection.slot(f.resident)?.snapshot.transform.world[12]).toBe(2);
    retireAll(task);
  });

  it.each([
    true,
    'empty',
  ] as const)('keeps real collection identity, revision and generations on controlled source changes (instances=%s)', (mode) => {
    const f = fixture(mode),
      task = f.begin();
    stageAll(task);
    f.draw();
    const first = f.shared.entry?.projection.slot(f.instanced);
    const instances = first?.snapshot.instances;
    if (first === undefined || instances === undefined || instances.collectionId === undefined)
      throw new Error('Missing actual accepted collection');
    expect(f.store._inspections(0)).toHaveLength(1);
    const active = f.source.setActive(true, f.source.capture().unwrap()).unwrap();
    task.acceptSource(active).unwrap();
    f.draw();
    const next = f.shared.entry?.projection.slot(f.instanced)?.snapshot.instances;
    expect(next?.collectionId).toBe(instances.collectionId);
    expect(next?.revision).toBe(instances.revision);
    expect(next?.generations).toBe(instances.generations);
    expect(f.store.project(f.world, f.instanced, instances.transforms)).toMatchObject({
      collectionId: instances.collectionId,
      revision: instances.revision,
    });
    task.acceptSource(f.source.setActive(false, active).unwrap()).unwrap();
    retireAll(task);
    expect(f.store._inspections(0)).toHaveLength(0);
  });

  it('survives the first actual simulation update after source acceptance', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    f.draw();
    task.acceptSource(f.source.setActive(true, f.source.capture().unwrap()).unwrap()).unwrap();
    f.world.update(0).unwrap();
    expect(task.isCurrent()).toBe(true);
    f.draw();
    expect(task.isCurrent()).toBe(true);
    task.acceptSource(f.source.setActive(false, f.source.capture().unwrap()).unwrap()).unwrap();
    retireAll(task);
  });

  it('keeps an exact collection cleanup receipt when acceptance throws after changing the store', () => {
    const f = fixture(true),
      task = f.begin();
    const original = f.store.accept.bind(f.store);
    const accept = vi.spyOn(f.store, 'accept').mockImplementationOnce((...args) => {
      original(...args);
      throw new Error('injected accepted collection fault');
    });
    let failed = false;
    for (let step = 0; step < 1000; step++) {
      const result = task.step();
      if (!result.ok) {
        failed = true;
        break;
      }
    }
    accept.mockRestore();
    expect(failed).toBe(true);
    expect(f.store._inspections(0)).toHaveLength(1);
    retireAll(task);
    expect(f.store._inspections(0)).toHaveLength(0);
  });

  it('drops no-frame responsibilities through the same owner maintenance after a real lease replacement', () => {
    const f = fixture(true),
      task = f.begin();
    stageAll(task);
    const replacement = createRenderReadLease(f.world);
    cleanups.push(() => replacement.dispose());
    f.view.extractComposition(f.world, f.assets, f.build, replacement);
    expect(task.isCurrent()).toBe(false);
    for (let step = 0; step < 1000; step++) {
      if (f.shared.maintainStagedSources(1).unwrap().remaining === 0) break;
    }
    expect(task.inspect().phase).toBe('retired');
    expect(f.store._inspections(0)).toHaveLength(0);
  });

  it('refuses source changes made during its private extraction without publishing stale rows', () => {
    const f = fixture(),
      task = f.begin();
    task.step().unwrap();
    f.world.set(f.instanced, Transform, { pos: [9, 0, 0] }).unwrap();
    expect(task.step().ok).toBe(false);
    expect(f.shared.entry?.projection.slot(f.instanced)).toBeUndefined();
    retireAll(task);
  });

  it('rejects skipped controlled generations instead of accepting the latest observation', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    const active = f.source.setActive(true, f.source.capture().unwrap()).unwrap();
    const inactive = f.source.setActive(false, active).unwrap();
    expect(task.acceptSource(inactive)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'successor' } },
    });
    retireAll(task);
  });

  it('preserves both staged source and Skin retirement failures without abandoning their owner', () => {
    const f = fixture(),
      task = f.begin();
    stageAll(task);
    const active = f.source.setActive(true, f.source.capture().unwrap()).unwrap();
    task.acceptSource(active).unwrap();
    const arena = new GpuInputArena(),
      skin = new SkinSceneInputs(arena, undefined);
    const entry = f.shared.entry;
    if (entry === undefined) throw new Error('Missing actual composition');
    entry.skin = skin;
    const skinFailure = new Error('injected Skin retirement failure');
    const original = skin.dispose.bind(skin);
    vi.spyOn(skin, 'dispose').mockImplementationOnce(() => {
      original();
      throw skinFailure;
    });
    let failure: unknown;
    try {
      f.shared.dispose();
    } catch (cause) {
      failure = cause;
    }
    const flatten = (value: unknown): unknown[] =>
      value instanceof AggregateError ? value.errors.flatMap(flatten) : [value];
    const causes = flatten(failure);
    expect(causes).toContain(skinFailure);
    expect(
      causes.some(
        (cause) => cause instanceof Error && cause.message === 'Staged mesh source: source',
      ),
    ).toBe(true);
    f.source.setActive(false, active).unwrap();
    for (let step = 0; step < 1000; step++)
      if (f.shared.maintainStagedSources(1).unwrap().remaining === 0) break;
    expect(task.inspect().phase).toBe('retired');
    arena.dispose();
  });

  it.each([
    'dispose',
    'maintenance',
  ])('quarantines a source-active group without starving stopped groups during no-frame %s', (mode) => {
    const f = fixture(true),
      first = f.begin();
    stageAll(first);
    const other = f.world
      .spawn(
        { component: Disabled, data: {} },
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: f.mesh } },
        { component: MeshRenderer, data: {} },
        {
          component: Instances,
          data: { transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
        },
      )
      .unwrap();
    finish(
      prepareSceneTransformsSteps(f.world, {
        members: [other],
        authorDisabled: new Set(),
        isCurrent: () => true,
      }),
    ).unwrap();
    const source = prepareSceneRosterParticipation(f.world, {
      members: [other],
      authorDisabled: new Set(),
      sourceComponents: meshSourceComponents(f.world),
      isCurrent: () => f.content.matchesCurrent(),
    }).unwrap();
    cleanups.push(() => source.dispose());
    const second = f.shared
      .beginStagedGroup(source.capture().unwrap(), f.content, f.lease)
      .unwrap();
    stageAll(second);
    expect(f.store._inspections(0)).toHaveLength(2);
    const active = f.source.setActive(true, f.source.capture().unwrap()).unwrap();
    first.acceptSource(active).unwrap();
    if (mode === 'dispose') expect(() => f.shared.dispose()).toThrow();
    else {
      f.shared.invalidate();
      let blocked = false;
      for (let step = 0; step < 1000; step++) {
        const result = first.retireStep();
        if (!result.ok) {
          expect(result.error.detail.reason).toBe('source');
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
      // A failed stop check must not advance past the still-live member on retry.
      for (let retry = 0; retry < f.source.capture().unwrap().members.length + 1; retry++)
        expect(first.retireStep()).toMatchObject({
          ok: false,
          error: { detail: { reason: 'source' } },
        });
      for (let step = 0; step < 1000 && second.inspect().phase !== 'retired'; step++)
        f.shared.maintainStagedSources(1);
    }
    expect(second.inspect().phase).toBe('retired');
    expect(f.store._inspections(0)).toHaveLength(0);
    expect(first.inspect().phase).not.toBe('retired');
    f.source.setActive(false, active).unwrap();
    for (let step = 0; step < 1000; step++) {
      const result = f.shared.maintainStagedSources(1);
      if (result.ok && result.value.remaining === 0) break;
    }
    expect(first.inspect().phase).toBe('retired');
  });
});
