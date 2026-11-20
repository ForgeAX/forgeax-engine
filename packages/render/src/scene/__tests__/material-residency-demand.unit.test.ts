import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease, readMutationEpoch } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { Camera, MeshFilter, MeshRenderer } from '../../components';
import type {
  RenderResidencyGroup,
  RenderResidencySelection,
} from '../../gpu-driven/batch-residency';
import { BatchTopology } from '../../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../../gpu-driven/draw-selection';
import { MaterialResource } from '../../material-resource';
import type { GpuOwnedFrame, RenderableSnapshot } from '../../render-system-extract';
import { extractSource } from '../../render-system-extract-tail';
import { FrameSet } from '../frame-set';
import { MaterialDispatch } from '../material-dispatch';
import { cullResidualFrame, type ResidualCullMemo } from '../persistent-cull';
import { PersistentRenderScene, RenderScene } from '../render-scene';
import { ResidualRoster } from '../residual-roster';
import { type PersistentRenderCandidateRequest, SceneComposition } from '../scene-composition';

function material() {
  return new MaterialResource({
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
      {
        name: 'ShadowCaster',
        program: { module: 'forgeax::default-shadow-caster' },
        renderState: { tags: { LightMode: 'ShadowCaster' }, queue: 2000 },
      },
    ],
  });
}

function fixture() {
  const scene = new RenderScene(),
    topology = new BatchTopology(),
    owner = new MaterialDispatch();
  const first = topology.createResidencyGroup(),
    second = topology.createResidencyGroup();
  const shared = material(),
    base = receiptRow().source;
  const sources: RenderableSnapshot[] = [undefined, first, second].map((residencyGroup, index) => ({
    ...base,
    entityKey: index + 1,
    material: shared,
    materials: [shared],
    ...(residencyGroup === undefined ? {} : { residencyGroup }),
  }));
  const apply = (snapshot: RenderableSnapshot) => {
    const delta = scene.apply([{ kind: 'update', entityKey: snapshot.entityKey, snapshot }]);
    topology.apply(delta);
    const slot = scene.slot(snapshot.entityKey);
    if (slot === undefined) throw new Error('Fixture source did not enter SceneRows');
    owner.bind(slot.slot, slot.snapshot);
    owner.prepare(scene.meshFrame());
  };
  for (const snapshot of sources) apply(snapshot);
  const query = () =>
    owner.query(
      scene.slotsSnapshot(),
      scene.meshFrame(),
      undefined,
      topology.captureResidencySelection(),
    );
  return { scene, topology, owner, first, second, sources, shared, apply, query };
}

function entities(entries: Iterable<{ readonly entityIndex: number }>) {
  return Array.from(new Set(Array.from(entries, (entry) => entry.entityIndex))).sort();
}

it('partitions shared material demand by the same real residency authority as batches', () => {
  const f = fixture();
  expect(entities(f.query())).toEqual([1]);
  expect(f.owner.materials().get(f.shared)?.bindings).toBe(1);
  f.topology.setResidencyGroupActive(f.first, true);
  const active = f.query();
  expect(entities(active)).toEqual([1, 2]);
  expect(f.owner.materials().get(f.shared)?.bindings).toBe(2);
  f.topology.setResidencyGroupActive(f.first, false);
  expect(entities(f.query())).toEqual([1]);
  expect(entities(active)).toEqual([1, 2]);
  f.topology.setResidencyGroupActive(f.second, true);
  expect(entities(f.query())).toEqual([1, 3]);
});

it('does not read inactive candidate material sources even with explicit pipeline preparation', () => {
  const f = fixture(),
    source = f.sources[1] as RenderableSnapshot;
  f.apply({
    ...source,
    authorVisible: false,
    pipelinePreparation: Array.from(f.query()),
  });
  const groups = (
    f.owner as unknown as {
      groups: Map<string, { residencyGroup: RenderResidencyGroup | undefined; source: object }>;
    }
  ).groups;
  const target = Array.from(groups.values()).find((group) => group.residencyGroup === f.first);
  if (target === undefined) throw new Error('Missing fixture residency binding');
  const descriptor = Object.getOwnPropertyDescriptor(target, 'source');
  if (descriptor === undefined) throw new Error('Missing admitted material source');
  Object.defineProperty(target, 'source', {
    configurable: true,
    get() {
      throw new Error('Inactive material source entered current demand');
    },
  });
  try {
    expect(entities(f.query())).toEqual([1]);
    expect(f.owner.materials().get(f.shared)?.bindings).toBe(1);
  } finally {
    Object.defineProperty(target, 'source', descriptor);
  }
});

it('requires the owning selection and rejects stale or foreign gate observations', () => {
  const f = fixture();
  expect(() => f.owner.query(f.scene.slotsSnapshot(), f.scene.meshFrame())).toThrow(
    'owning residency selection',
  );
  const selection = f.topology.captureResidencySelection();
  f.topology.setResidencyGroupActive(f.first, true);
  expect(selection.isCurrent()).toBe(false);
  expect(() =>
    f.owner.query(f.scene.slotsSnapshot(), f.scene.meshFrame(), undefined, selection),
  ).toThrow('stale');
  const foreign = new BatchTopology().captureResidencySelection();
  expect(() =>
    f.owner.query(f.scene.slotsSnapshot(), f.scene.meshFrame(), undefined, foreign),
  ).toThrow('foreign or retired');
  expect(entities(f.query())).toEqual([1, 2]);
});

it('rejects a gate mutation in the validation callback before publishing any new demand', () => {
  const f = fixture(),
    before = f.query(),
    materials = f.owner.materials();
  const selection = f.topology.captureResidencySelection();
  expect(() =>
    f.owner.query(
      f.scene.slotsSnapshot(),
      f.scene.meshFrame(),
      () => {
        f.topology.setResidencyGroupActive(f.first, true);
      },
      selection,
    ),
  ).toThrow('stale');
  expect(f.owner.materials()).toBe(materials);
  expect(entities(before)).toEqual([1]);
  expect(entities(f.query())).toEqual([1, 2]);
});

it('preserves authored visibility and caster intent after group activation and content edits', () => {
  const f = fixture();
  f.apply({ ...(f.sources[1] as RenderableSnapshot), shadowCaster: false });
  f.apply({ ...(f.sources[2] as RenderableSnapshot), authorVisible: false });
  f.topology.setResidencyGroupActive(f.first, true);
  f.topology.setResidencyGroupActive(f.second, true);
  const entries = Array.from(f.query());
  expect(entities(entries)).toEqual([1, 2]);
  expect(entities(entries.filter((entry) => entry.tags.LightMode === 'ShadowCaster'))).toEqual([1]);
  expect(f.owner.displays(f.scene.slot(3)?.slot ?? -1)).toBe(false);
  f.apply({ ...(f.sources[1] as RenderableSnapshot), layer: 7, shadowCaster: false });
  expect(Array.from(f.query()).find((entry) => entry.entityIndex === 2)?.layer).toBe(7);
});

it('invalidates captured selections when the real topology is rebuilt', () => {
  const f = fixture(),
    selection = f.topology.captureResidencySelection();
  f.topology.rebuild(new RenderScene().slotsSnapshot());
  expect(selection.isCurrent()).toBe(false);
  expect(() => selection.includes(f.first)).toThrow('stale');
  expect(() => f.topology.captureResidencySelection().includes(f.first)).toThrow(
    'foreign or retired',
  );
});

it('selects actual explicit preparation slots without changing author intent or resident storage', () => {
  const f = fixture(),
    preparation = Array.from(f.query());
  for (const snapshot of f.sources) f.apply({ ...snapshot, pipelinePreparation: preparation });
  const source = f.scene.pipelinePreparationSlots;
  expect(source.size).toBe(3);
  const first = f.topology.captureResidencySelection();
  const inactive = first.selectSlots(source);
  expect(Array.from(inactive)).toEqual([f.scene.slot(1)?.slot]);
  expect(first.selectSlots(source)).toBe(inactive);
  f.topology.setResidencyGroupActive(f.first, true);
  expect(() => first.selectSlots(source)).toThrow('stale');
  const active = f.topology.captureResidencySelection().selectSlots(source);
  expect(Array.from(active)).toEqual([f.scene.slot(1)?.slot, f.scene.slot(2)?.slot]);
  expect(source.size).toBe(3);
  expect(f.scene.slot(2)?.snapshot.pipelinePreparation).toBeDefined();
});

it('keeps unchanged gate observations and ordinary slot roots stable', () => {
  const topology = new BatchTopology(),
    scene = new RenderScene();
  const selection = topology.captureResidencySelection();
  expect(topology.captureResidencySelection()).toBe(selection);
  expect(selection.selectSlots(scene.pipelinePreparationSlots)).toBe(
    scene.pipelinePreparationSlots,
  );
});

it('rejects forged and copied observations before invoking validation callbacks', () => {
  const f = fixture(),
    real = f.topology.captureResidencySelection();
  const forged: RenderResidencySelection = {
    phase: 'active',
    isCurrent: () => true,
    includes: () => true,
    selectSlots: (source) => source,
  };
  for (const selection of [forged, { ...real, includes: () => true }]) {
    const validate = vi.fn();
    expect(() =>
      f.owner.query(f.scene.slotsSnapshot(), f.scene.meshFrame(), validate, selection),
    ).toThrow('foreign or forged');
    expect(validate).not.toHaveBeenCalled();
  }
  expect(entities(f.query())).toEqual([1]);
});

it('keeps resident metadata demand separate from ordinary dispatch and its cache', () => {
  const f = fixture(),
    active = f.query(),
    materials = f.owner.materials();
  const selection = f.topology.captureResidentSelection();
  const resident = f.owner.queryResident(f.scene.slotsSnapshot(), selection, f.scene.meshFrame());
  expect(entities(resident.dispatch)).toEqual([1, 2, 3]);
  expect(resident.materials.get(f.shared)?.bindings).toBe(3);
  expect(f.owner.materials()).toBe(materials);
  expect(f.query()).toBe(active);
  expect(entities(active)).toEqual([1]);
  f.topology.setResidencyGroupActive(f.first, true);
  expect(selection.isCurrent()).toBe(true);
  expect(resident.isCurrent()).toBe(true);
  const next = f.owner.queryResident(
    f.scene.slotsSnapshot(),
    f.topology.captureResidentSelection(),
    f.scene.meshFrame(),
  );
  expect(next.dispatch).toBe(resident.dispatch);
  expect(next.materials).toBe(resident.materials);
  expect(entities(f.query())).toEqual([1, 2]);
  expect(resident.materials.get(f.shared)?.bindings).toBe(3);
});

it('rejects a genuine resident observation as permission for current execution', () => {
  const f = fixture(),
    selection = f.topology.captureResidentSelection(),
    validate = vi.fn();
  expect(() =>
    f.owner.query(f.scene.slotsSnapshot(), f.scene.meshFrame(), validate, selection),
  ).toThrow('wrong phase');
  expect(validate).not.toHaveBeenCalled();
  expect(() =>
    f.owner.queryResident(f.scene.slotsSnapshot(), f.topology.captureResidencySelection()),
  ).toThrow('wrong phase');
});

it('invalidates resident data on source edits and preserves active demand after a resident refusal', () => {
  const f = fixture(),
    active = f.query(),
    materials = f.owner.materials();
  const selection = f.topology.captureResidentSelection();
  expect(() =>
    f.owner.queryResident(f.scene.slotsSnapshot(), selection, f.scene.meshFrame(), () => {
      throw new Error('resident refusal');
    }),
  ).toThrow('resident refusal');
  expect(f.owner.materials()).toBe(materials);
  expect(f.query()).toBe(active);
  const resident = f.owner.queryResident(f.scene.slotsSnapshot(), selection, f.scene.meshFrame());
  f.apply({ ...(f.sources[1] as RenderableSnapshot), layer: 8 });
  expect(resident.isCurrent()).toBe(false);
  const next = f.owner.queryResident(
    f.scene.slotsSnapshot(),
    f.topology.captureResidentSelection(),
    f.scene.meshFrame(),
  );
  expect(Array.from(next.dispatch).find((entry) => entry.entityIndex === 2)?.layer).toBe(8);
});

it('gates GPU-lane lazy visibility and statistics before any inactive bounds read', () => {
  const f = fixture(),
    residualOwner = new ResidualRoster();
  const base = extractSource(new World());
  const memo: { value: ResidualCullMemo | undefined } = { value: undefined };
  const sample = () => {
    const dispatch = f.query(),
      plan = f.topology.sourcePlan();
    const gpu = new GpuDrawSelection(f.topology.query(plan, undefined).active.batches);
    const residual = residualOwner.sync(plan, f.topology.unbatchedSlots, gpu);
    expect(residual.size).toBe(0);
    const slots = f.scene.slotsSnapshot();
    const owned: GpuOwnedFrame = {
      selection: gpu,
      slots,
      residualSet: () => residual,
      residualSlots: () => slots.filter((record) => residual.has(record.slot)),
      residual: () => [],
      displays: (row) => f.owner.displays(f.scene.slot(row.entityKey)?.slot ?? -1),
      row: (entity) => f.scene.slot(entity)?.snapshot,
    };
    const selection = f.topology.captureResidencySelection();
    const frame = { ...base, renderables: f.scene.materialize(selection), dispatch };
    const visited: number[] = [];
    const result = cullResidualFrame(
      frame,
      f.owner.materials(),
      (row, _index, out) => {
        if (row.residencyGroup !== undefined && !selection.includes(row.residencyGroup))
          throw new Error('Inactive bounds read');
        visited.push(row.entityKey);
        out.set([-1, -1, -1, 1, 1, 1]);
        return true;
      },
      owned,
      gpu,
      memo,
      {
        meshes: f.scene.meshFrame(),
        skin: undefined,
        unavailable: new FrameSet(),
        residencySelection: selection,
      },
    );
    return { result, visited };
  };
  const inactive = sample();
  expect(inactive.result.frame.cameraVisible?.(f.sources[1] as RenderableSnapshot)).toBe(false);
  expect(inactive.result.frame.frustumStats.total).toBe(1);
  expect(inactive.visited).toEqual([1]);
  f.topology.setResidencyGroupActive(f.first, true);
  const active = sample();
  expect(active.result.frame.cameraVisible?.(f.sources[1] as RenderableSnapshot)).toBe(true);
  expect(active.result.frame.frustumStats.total).toBe(2);
  expect(active.visited.sort()).toEqual([1, 2]);
});

it.each([
  false,
  true,
])('refreshes actual composition demand without re-extracting source content (temporal=%s)', (temporal) => {
  const assets = new AssetRegistry(),
    world = new World({ assets });
  const releaseTransforms = registerPropagateTransforms(world),
    lease = createRenderReadLease(world);
  const shared = new SceneComposition(),
    scene = new PersistentRenderScene({ getTemporalConsumerDemand: () => temporal }, shared, false);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  world.update(0).unwrap();
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  let group: RenderResidencyGroup | undefined, entity: EntityHandle | undefined;
  const requests: PersistentRenderCandidateRequest[] = [];
  const build = (request: PersistentRenderCandidateRequest) => {
    requests.push(request);
    const frame = extractSource(world, assets, scene.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
    });
    return {
      ...frame,
      renderables: frame.renderables.map((snapshot) =>
        snapshot.entityKey === entity && group !== undefined
          ? { ...snapshot, residencyGroup: group }
          : snapshot,
      ),
    };
  };
  const draw = () => scene.extractComposition(world, assets, build, lease);
  try {
    draw();
    const entry = shared.entry;
    if (entry === undefined) throw new Error('Missing real source composition');
    group = entry.topology.createResidencyGroup();
    entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    world.update(0).unwrap();
    const closed = draw();
    expect(entities(closed.dispatch)).toEqual([]);
    const source = entry.projection.slot(entity)?.snapshot;
    if (source === undefined) throw new Error('Missing retained candidate');
    expect(closed.cameraVisible?.(source)).toBe(false);
    expect(source.authorVisible).not.toBe(false);
    const revision = entry.projection.revisionValue(),
      epoch = readMutationEpoch(world);
    requests.length = 0;
    entry.topology.setResidencyGroupActive(group, true);
    expect(() => shared.materialPasses(entry)).toThrow('stale');
    expect(() => shared.batchPlan(entry)).toThrow('stale');
    expect(entities(draw().dispatch)).toEqual([entity]);
    expect(entry.projection.revisionValue()).toBe(revision);
    expect(readMutationEpoch(world)).toBe(epoch);
    expect(requests.every((request) => request === 'none')).toBe(true);
    entry.topology.setResidencyGroupActive(group, false);
    expect(entities(draw().dispatch)).toEqual([]);
    expect(entry.projection.slotsSnapshot()).toHaveLength(1);
  } finally {
    scene.dispose();
    shared.dispose();
    lease.dispose();
    releaseTransforms();
    assets.dispose();
  }
});

it.each([
  false,
  true,
])('retires exclusive Source material roots without another query (previously active=%s)', (active) => {
  const f = fixture();
  const permanent = f.query();
  const resource = material();
  const source = f.sources[1] as RenderableSnapshot;
  f.apply({ ...source, material: resource, materials: [resource] });
  if (active) f.topology.setResidencyGroupActive(f.first, true);
  const resident = f.owner.queryResident(
    f.scene.slotsSnapshot(),
    f.topology.captureResidentSelection(),
    f.scene.meshFrame(),
  );
  const issued = active ? f.query() : resident.dispatch;
  const cache = f.owner as unknown as {
    readonly active: {
      readonly materialFrame: { get(resource: MaterialResource): unknown };
      readonly groupResources: Map<object, readonly MaterialResource[]>;
      readonly dirtyGroups: Set<object>;
    };
    readonly resident: {
      readonly materialFrame: { get(resource: MaterialResource): unknown };
      readonly groupResources: Map<object, readonly MaterialResource[]>;
      readonly dirtyGroups: Set<object>;
    };
    readonly recentBinding?: { readonly key: string };
    readonly groups: Map<string, object>;
  };
  const slot = f.scene.slot(source.entityKey)?.slot;
  if (slot === undefined) throw Error('Missing Source slot');
  const sourceGroup = [...cache.resident.groupResources].find(([, resources]) =>
    resources.includes(resource),
  )?.[0];
  expect(sourceGroup).toBeDefined();
  const permanentMaterial = f.owner.materials().get(f.shared);
  f.owner.remove(slot);
  for (const lane of [cache.active, cache.resident]) {
    expect(lane.materialFrame.get(resource)).toBeUndefined();
    expect(lane.groupResources.has(sourceGroup as object)).toBe(false);
    expect(lane.dirtyGroups.has(sourceGroup as object)).toBe(false);
  }
  expect(cache.recentBinding).toBeUndefined();
  expect(f.owner.materials().get(f.shared)).toBe(permanentMaterial);
  // A caller's already-issued immutable roots remain valid until it releases them.
  expect(resident.materials.get(resource)).toBeDefined();
  expect(entities(issued)).toContain(source.entityKey);
  expect(entities(permanent)).toEqual([1]);
});

it('keeps shared material consumers while retiring a Source without another query', () => {
  const f = fixture();
  f.topology.setResidencyGroupActive(f.first, true);
  const active = f.query();
  const resident = f.owner.queryResident(
    f.scene.slotsSnapshot(),
    f.topology.captureResidentSelection(),
    f.scene.meshFrame(),
  );
  const slot = f.scene.slot(2)?.slot;
  if (slot === undefined) throw Error('Missing Source slot');
  const cache = f.owner as unknown as {
    readonly resident: {
      readonly materialFrame: { get(resource: MaterialResource): { bindings: number } | undefined };
    };
  };
  f.owner.remove(slot);
  expect(f.owner.materials().get(f.shared)?.bindings).toBe(1);
  expect(cache.resident.materialFrame.get(f.shared)?.bindings).toBe(2);
  expect(entities(active)).toEqual([1, 2]);
  expect(entities(resident.dispatch)).toEqual([1, 2, 3]);
  expect(resident.materials.get(f.shared)?.bindings).toBe(3);
});
