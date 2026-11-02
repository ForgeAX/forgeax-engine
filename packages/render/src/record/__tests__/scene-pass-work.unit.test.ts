import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { frustum, mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import type { MeshGpuHandles } from '../../device/gpu-residency';
import { BatchTopology } from '../../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../../gpu-driven/draw-selection';
import type { PreparedGpuDrivenDraw } from '../../gpu-driven/prepared-draw';
import { MaterialResource } from '../../material-resource';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { MaterialSnapshot } from '../../render-system-extract';
import { FrameSet } from '../../scene/frame-set';
import { MaterialDispatch, MaterialFrame } from '../../scene/material-dispatch';
import { ProbeBlendSceneProjection } from '../../scene/probe-blend';
import { RenderScene } from '../../scene/render-scene';
import { FORWARD_PASS_SELECTOR } from '../../systems/pass-selector';
import { createTemporalView } from '../../temporal/view';
import { ViewDrawPhases } from '../direct-draw-phase';
import { buildDispatchPlan, cleanPerFrameCaches, computeFoldBuckets } from '../fold-buckets';
import { resolveFoldInstanceBuffer, retainedFoldInstanceKeys } from '../fold-instance-buffer';
import { makeZeroCameraFallbackSnapshot, type ValidatedRenderable } from '../frame-snapshot';
import { computeProjectionMatrix } from '../helpers';
import { selectMainPassDispatch, selectMainPassMaterials } from '../main-pass';
import { prepareScenePasses, type ScenePassRequest, scenePassContext } from '../scene-pass-work';

function material(
  handle: number,
  modes: readonly string[],
  fields: Partial<MaterialSnapshot> = {},
) {
  return new MaterialResource({
    ...receiptRow().source.material.snapshot,
    materialHandle: handle,
    materialShaderId: 'forgeax::default-standard-pbr',
    passes: modes.map((mode) => ({
      name: mode,
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: mode } },
    })),
    ...fields,
  });
}

function request(mode: string, fields: Partial<ScenePassRequest> = {}): ScenePassRequest {
  return {
    selector: { LightMode: [mode] },
    excludeSelector: undefined,
    recordMode: 'opaque',
    passKind: mode.toLowerCase(),
    gpu: true,
    gpuFilter: undefined,
    late: false,
    capture: false,
    ...fields,
  };
}

function fixture(count: number) {
  const shared = material(1, ['Forward', 'Deferred'], { deferredPass: true });
  const noLod = material(2, ['Forward']);
  const deferredOnly = material(3, ['Deferred']);
  const medium = material(4, ['Medium'], { surfaceModel: 'single-layer-medium' });
  const sources = [...Array.from({ length: count }, () => shared), noLod, deferredOnly, medium].map(
    (resource, entityKey) => {
      const base = receiptRow().source;
      return {
        ...base,
        entityKey,
        material: resource,
        materials: [resource],
        gpuDrivenDraws: base.gpuDrivenDraws?.slice(0, 1) ?? [],
      };
    },
  );
  const scene = new RenderScene();
  const topology = new BatchTopology();
  const dispatch = new MaterialDispatch();
  topology.apply(
    scene.apply(
      sources.map((snapshot) => ({
        kind: 'update',
        worldId: 0,
        entityKey: snapshot.entityKey,
        snapshot,
      })),
    ),
  );
  for (const row of scene.slotsSnapshot()) dispatch.bind(row.slot, row.snapshot);
  const plan = topology.query(topology.sourcePlan(), undefined);
  const gpuBatches = plan.batches
    .filter((batch) => batch.binding?.material === shared || batch.binding?.material === noLod)
    .map((batch) => ({
      ...batch,
      key: {
        ...batch.key,
        materialPass:
          batch.binding?.material === shared ? ('deferred' as const) : ('forward-only' as const),
      },
      prepared: {
        identity: {
          material: 'forgeax::default-standard-pbr',
          geometry: 'triangle',
          deformation: 'rigid',
        },
      } as PreparedGpuDrivenDraw,
      ...(batch.binding?.material === shared ? { lod: { coverages: [1, 0.5], ranges: [] } } : {}),
    }));
  const mesh = {
    submeshes: Array.from({ length: 3 }, () => ({ materialSlot: 0 })),
  } as unknown as MeshGpuHandles;
  const worlds = [
    { identity: 'pass-work-world', transparentSort: { mode: 0, yzAlpha: 1 } },
  ] as unknown as RenderResourceScope[];
  const gpu = new GpuDrawSelection(gpuBatches);
  const meshes = new Map(
    plan.batches.map((batch) => {
      assert(batch.binding);
      return [batch.binding, mesh] as const;
    }),
  );
  const project = vi.fn((rows: readonly ValidatedRenderable[]) =>
    dispatch.materials().project(
      rows.map((row) => {
        const record = scene.slot(row.source.worldId, row.source.entityKey);
        assert(record);
        return { slot: record.slot, source: row.source, renderableIndex: row.renderableIndex };
      }),
    ),
  );
  const world = worlds[0];
  assert(world);
  return {
    world,
    shared,
    noLod,
    deferredOnly,
    medium,
    scene,
    topology,
    plan,
    gpu,
    meshes,
    worlds,
    dispatch,
    project,
  };
}

it('retains TAA Direct edge geometry admitted by the jittered camera', () => {
  const f = fixture(1);
  const camera = { ...makeZeroCameraFallbackSnapshot(), fov: Math.PI / 2 };
  const taaCamera = { ...camera, antialias: 'taa' as const };
  const bounds = new Float32Array([5.009, -0.1, -5.0001, 5.011, 0.1, -4.9999]);
  const projection = computeProjectionMatrix(camera, mat4.create());
  const planes = frustum.fromViewProjection(frustum.create(), projection);
  const temporal = createTemporalView({ antialias: 'taa', width: 64, height: 64, frameIndex: 1 });
  assert(temporal.currentJitterUv);
  const jitter = mat4.identity(mat4.create());
  jitter[12] = temporal.currentJitterUv[0] * 2;
  jitter[13] = temporal.currentJitterUv[1] * -2;
  const jitteredPlanes = frustum.fromViewProjection(
    frustum.create(),
    mat4.multiply(mat4.create(), jitter, projection),
  );
  expect(frustum.intersectsBox(planes, bounds)).toBe(false);
  expect(frustum.intersectsBox(jitteredPlanes, bounds)).toBe(true);
  const source = f.scene.slot(0, 0)?.snapshot;
  assert(source);
  const matrix = new Float32Array(source.transform.world);
  matrix[12] = 5.01;
  matrix[14] = -5;
  f.topology.apply(
    f.scene.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey: 0,
        snapshot: {
          ...source,
          transform: { ...source.transform, world: matrix },
          localAabb: new Float32Array([-0.001, -0.1, -0.0001, 0.001, 0.1, 0.0001]),
        },
      },
    ]),
  );
  const visible = vi.fn(() => frustum.intersectsBox(planes, bounds));
  const prepared = prepareScenePasses(
    [request('Forward', { gpu: false, camera: () => taaCamera })],
    {
      phases: new ViewDrawPhases(),
      scene: {
        plan: f.topology.query(f.topology.sourcePlan(), undefined),
        slotAt: f.scene.slotAt,
        drawSnapshotAt: f.scene.drawSnapshotAt,
        unbatchedSlots: new FrameSet(),
      },
      materials: f.dispatch.materials(),
      gpu: f.gpu,
      meshes: f.meshes,
      worlds: f.worlds,
      prepareUnbatched: () => [],
      viewDraws: [],
      prepareGeometry: (mesh) => mesh,
      fold: () => [],
      lod: (rows) => rows,
      world: f.world,
      camera: camera,
      cameraVisible: visible,
    },
  );
  expect(prepared.rows.some((row) => row.source.entityKey === 0)).toBe(true);
  expect(visible).not.toHaveBeenCalled();
});

it('prepares separate actual Pass work without expanding unrelated GPU members', () => {
  const f = fixture(10_000);
  const forward = request('Forward');
  const temporal = request('Forward', { passKind: 'temporal' });
  const deferred = request('Deferred');
  const medium = request('Forward', { recordMode: 'single-layer-medium-color' });
  const late = request('Forward', { late: true });
  const slotAt = vi.fn(f.scene.slotAt);
  const plan = {
    ...f.plan,
    batches: f.plan.batches.map((batch) =>
      batch.binding?.material !== f.shared
        ? batch
        : {
            ...batch,
            get members(): never {
              throw new Error('Pure GPU source members enumerated');
            },
            get candidates(): never {
              throw new Error('Pure GPU candidates enumerated');
            },
          },
    ),
  };
  const prepared = prepareScenePasses([forward, temporal, deferred, medium, late], {
    phases: new ViewDrawPhases(),
    scene: {
      plan,
      slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: f.dispatch.materials(),
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: () => [],
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
  });
  expect(slotAt).toHaveBeenCalledTimes(3);
  expect(prepared.rows.map((row) => row.source.entityKey)).toEqual([10_000, 10_001, 10_002]);
  const planned = buildDispatchPlan(
    { meshSsboState: { meshSlotCount: 3, materialSlotCount: 3 } } as never,
    prepared.rows,
    prepared.dispatch,
    prepared.buckets,
    [],
    undefined,
    false,
    { bindings: [], worlds: f.worlds, frame: f.dispatch.materials() },
    f.scene,
  );
  const work = prepared.finish(planned);
  expect(work.get(forward)?.validatedOrdered).toEqual([]);
  expect(work.get(temporal)?.validatedOrdered.map((row) => row.source.entityKey)).toEqual([10_000]);
  expect(work.get(deferred)?.validatedOrdered.map((row) => row.source.entityKey)).toEqual([10_001]);
  expect(work.get(medium)?.validatedOrdered.map((row) => row.source.entityKey)).toEqual([10_002]);
  expect(work.get(late)?.validatedOrdered).toEqual([]);
  for (const selected of work.values())
    for (const [index, row] of selected.validatedOrdered.entries())
      expect(
        planned.materialSlots[selected.materialSlotIndices.at(index)?.[0] ?? -1]?.materialHandle,
      ).toBe(row.source.material.snapshot.materialHandle);
});

it('captures all selected sources independently of display GPU and material adoption', () => {
  const f = fixture(2);
  const frame = f.dispatch.materials();
  const capture = request('Forward', { gpu: false, capture: true });
  const display = request('Forward');
  f.shared.adopt({ ...f.shared.snapshot, passes: [] });
  f.dispatch.adopt(f.shared);
  const prepared = prepareScenePasses([display, capture], {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: frame,
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: () => {
      throw new Error('Capture must not fold');
    },
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
  });
  expect(prepared.rows.map((row) => row.source.entityKey)).toEqual([0, 1, 2]);
  expect(prepared.dispatch.map((entry) => entry.tags.LightMode)).toEqual([
    'Forward',
    'Forward',
    'Forward',
  ]);
});

it('sorts each requested camera before folding its CPU draws', () => {
  const f = fixture(2);
  f.shared.adopt({
    ...f.shared.snapshot,
    transparent: true,
    passes: [
      {
        name: 'transparent',
        program: { module: 'forgeax::sprite' },
        renderState: {
          tags: { LightMode: 'Forward' },
          queue: 3000,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      },
    ],
  });
  f.dispatch.adopt(f.shared);
  const records = f.scene.slotsSnapshot();
  for (const [index, z] of [1, 10].entries()) {
    const record = records.at(index);
    assert(record);
    const source = {
      ...record.snapshot,
      transform: {
        ...record.snapshot.transform,
        world: new Float32Array(record.snapshot.transform.world),
      },
    };
    source.transform.world[14] = z;
    f.topology.apply(
      f.scene.apply([
        { kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot: source },
      ]),
    );
    f.dispatch.bind(record.slot, source);
  }
  const camera = (z: number) => ({ position: new Float32Array([0, 0, z]) }) as never;
  const display = request('Forward', { gpu: false, recordMode: 'transparent' });
  const capture = request('Forward', {
    gpu: false,
    recordMode: 'transparent',
    capture: true,
    camera: () => camera(20),
  });
  const folding = vi.fn((_dispatch: import('../../render-system-extract').DispatchList) => []);
  // The Pass edit changed the shared material's batch class: its rows moved batches.
  const plan = f.topology.query(f.topology.sourcePlan(), undefined);
  const mesh = f.meshes.values().next().value;
  assert(mesh);
  const meshes = new Map(plan.batches.map((batch) => [batch.binding ?? assert.fail(), mesh]));
  const work = prepareScenePasses([display, capture], {
    phases: new ViewDrawPhases(),
    scene: {
      plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: f.dispatch.materials(),
    gpu: f.gpu,
    meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: folding,
    lod: (rows) => rows,
    world: { transparentSort: { mode: 3, yzAlpha: 1 } } as never,
    camera: camera(0),
  });
  expect(work.dispatch.map((entry) => entry.entityIndex)).toEqual([1, 0, 0, 1]);
  expect(folding.mock.calls[0]?.[0].map((entry) => entry.entityIndex)).toEqual([1, 0]);
});

it('retains exact unbatched submeshes when one material is excluded by another Pass', () => {
  const f = fixture(0);
  const { gpuDrivenDraws: _draws, ...base } = receiptRow().source;
  const source = {
    ...base,
    entityKey: 10,
    material: f.shared,
    materials: [f.shared, f.noLod],
  };
  const events = f.scene.apply([{ kind: 'update', worldId: 0, entityKey: 10, snapshot: source }]);
  const slot = f.scene.slot(0, 10);
  assert(slot);
  f.dispatch.bind(slot.slot, source);
  f.topology.apply(events);
  const mesh = {
    submeshes: [{ materialSlot: 0 }, { materialSlot: 1 }],
  } as unknown as MeshGpuHandles;
  const work = prepareScenePasses(
    [request('Forward', { gpu: false, excludeSelector: { LightMode: ['Deferred'] } })],
    {
      phases: new ViewDrawPhases(),
      scene: {
        plan: { ...f.plan, batches: [] },
        slotAt: f.scene.slotAt,
        drawSnapshotAt: f.scene.drawSnapshotAt,
        unbatchedSlots: FrameSet.from([slot.slot]),
      },
      materials: f.dispatch.materials(),
      gpu: f.gpu,
      meshes: f.meshes,
      worlds: f.worlds,
      prepareUnbatched: (sources) =>
        sources.map(
          (source, renderableIndex) =>
            ({ source, renderableIndex, mesh, meshSlot: 0 }) as ValidatedRenderable,
        ),
      viewDraws: [],
      prepareGeometry: (mesh) => mesh,
      fold: () => [],
      lod: (rows) => rows,
      world: f.world,
      camera: undefined,
    },
  );
  expect(work.rows[0]?.submeshIndices).toEqual([1]);
  expect(work.dispatch.map((entry) => entry.materialHandle)).toEqual([2]);
});

it('records the captured material mode and clears already resolved GPU exclusions', () => {
  const f = fixture(1);
  let frame = f.dispatch.materials();
  for (const resource of [f.shared, f.noLod, f.deferredOnly, f.medium])
    frame = frame.with(resource, undefined, { ...resource.snapshot, immutableValues: true });
  const pass = request('Forward', {
    selector: FORWARD_PASS_SELECTOR,
    gpuFilter: 'forward-only-opaque',
  });
  f.shared.adopt({ ...f.shared.snapshot, transparent: true });
  f.dispatch.adopt(f.shared);
  const prepared = prepareScenePasses([pass], {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: frame,
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: () => [],
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
  });
  const plan = buildDispatchPlan(
    { meshSsboState: { meshSlotCount: 4, materialSlotCount: 4 } } as never,
    prepared.rows,
    prepared.dispatch,
    [],
    [],
    undefined,
    false,
    { bindings: [], worlds: f.worlds, frame },
    f.scene,
  );
  const marker = Symbol('frame-owned-field');
  const source = {
    materialSlots: plan.materialSlots,
    scenePassWork: prepared.finish(plan),
    gpuDrivenSelection: f.gpu,
    [marker]: {},
  };
  const context = scenePassContext(source as never, pass);
  const sibling = scenePassContext(source as never, pass);
  expect(context).not.toBe(source);
  expect(sibling).not.toBe(context);
  expect(Reflect.get(context, marker)).toBe(source[marker]);
  expect(source.gpuDrivenSelection).toBe(f.gpu);
  context.hdrpSsaoBlurredView = {} as never;
  expect(sibling.hdrpSsaoBlurredView).toBeUndefined();
  expect(context.validatedOrdered.map((row) => row.source.entityKey)).toEqual([0]);
  // The actual Scene Pass already admitted these entries. Keep its fixed key so
  // the geometry owner's retained Pass grouping survives a fresh record context.
  expect(selectMainPassDispatch(context, FORWARD_PASS_SELECTOR)).toBe(context.dispatch);
  expect(selectMainPassDispatch(sibling, FORWARD_PASS_SELECTOR)).toBe(context.dispatch);
  expect(context.geometryMaterialPasses?.dispatch).toBe(context.dispatch);
  expect(context.geometryMaterialPasses?.validatedOrdered).toBe(context.validatedOrdered);
  expect(context.geometryMaterialPasses?.ordered).toBe(true);
  expect(context.geometryMaterialPasses?.groups.get(0)?.get(1)).toBe(context.dispatch.at(0));
  const foreign = {
    ...context,
    dispatch: [...context.dispatch, { ...context.dispatch.at(0), tags: { LightMode: 'Deferred' } }],
  } as typeof context;
  expect(selectMainPassDispatch(foreign, FORWARD_PASS_SELECTOR)).toEqual(context.dispatch);
  const slots = context.materialSlotIndices;
  const firstSlots = Object.getOwnPropertyDescriptor(slots, '0');
  assert(firstSlots);
  let slotReads = 0;
  Object.defineProperty(slots, '0', {
    configurable: true,
    get() {
      slotReads++;
      return firstSlots.value;
    },
  });
  try {
    expect(selectMainPassMaterials(context, pass.selector, 'opaque')?.size).toBe(1);
    expect(slotReads).toBe(0);
    expect(selectMainPassMaterials(context, pass.selector, 'transparent')?.size).toBe(0);
    expect(slotReads).toBeGreaterThan(0);
  } finally {
    Object.defineProperty(slots, '0', firstSlots);
  }
  expect(context.gpuDrivenSelection).toBeUndefined();
  expect(() => scenePassContext(context, request('Forward'))).toThrow('prepared draw work');
});

it.each([
  false,
  true,
])('keeps borrowed and clipped Scene Pass selection live (owned=%s)', (owned) => {
  const f = fixture(2);
  let frame = f.dispatch.materials();
  for (const resource of [f.shared, f.noLod, f.deferredOnly, f.medium]) {
    const { immutableValues: _owned, ...borrowed } = resource.snapshot;
    frame = frame.with(
      resource,
      undefined,
      owned ? { ...borrowed, immutableValues: true } : borrowed,
    );
  }
  const pass = request('Forward', { selector: FORWARD_PASS_SELECTOR, gpu: false });
  const prepared = prepareScenePasses([pass], {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: frame,
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: () => [],
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
  });
  const plan = buildDispatchPlan(
    { meshSsboState: { meshSlotCount: 8, materialSlotCount: 8 } } as never,
    prepared.rows,
    prepared.dispatch,
    [],
    [],
    undefined,
    false,
    { bindings: [], worlds: f.worlds, frame },
    f.scene,
  );
  const context = scenePassContext(
    { materialSlots: plan.materialSlots, scenePassWork: prepared.finish(plan) } as never,
    pass,
  );
  expect(context.validatedOrdered).toHaveLength(3);
  const selected = selectMainPassDispatch(context, FORWARD_PASS_SELECTOR);
  expect(selected === context.dispatch).toBe(owned);
  expect(context.geometryMaterialPasses !== undefined).toBe(owned);
  const reversed = { ...plan, validatedOrdered: [...plan.validatedOrdered].reverse() };
  const reordered = scenePassContext(
    { materialSlots: plan.materialSlots, scenePassWork: prepared.finish(reversed) } as never,
    pass,
  );
  expect(reordered.validatedOrdered.map((row) => row.renderableIndex)).toEqual(
    [...context.validatedOrdered].reverse().map((row) => row.renderableIndex),
  );
  expect(reordered.geometryMaterialPasses?.ordered).toBe(owned ? false : undefined);
  const override = {
    ...context,
    materialSlots: context.materialSlots.map((material) => ({ ...material, transparent: true })),
  };
  expect(selectMainPassMaterials(override, pass.selector, 'opaque')?.size).toBe(0);
  const clipped = { ...plan, validatedOrdered: plan.validatedOrdered.slice(0, 2) };
  const clippedContext = scenePassContext(
    { materialSlots: plan.materialSlots, scenePassWork: prepared.finish(clipped) } as never,
    pass,
  );
  expect(clippedContext.validatedOrdered).toHaveLength(2);
  expect(clippedContext.geometryMaterialPasses).toBeUndefined();
  expect(selectMainPassMaterials(clippedContext, pass.selector, 'opaque')?.size).toBe(2);
});

it('uses current camera admission before CPU validation while captures keep their own roster', () => {
  const f = fixture(2);
  const display = request('Forward', { gpu: false });
  const capture = request('Forward', { gpu: false, capture: true });
  const visible = vi.fn((source) => source.entityKey === 1);
  const prepared = prepareScenePasses([display, capture], {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: f.dispatch.materials(),
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: () => [],
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
    cameraVisible: visible,
  });
  expect(prepared.rows.map((row) => row.source.entityKey)).toEqual([1, 0, 1, 2]);
  expect(visible).toHaveBeenCalledTimes(3);
});

it('retains separate live fold buffers across cleanup and retires absent graph work', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const f = fixture(2);
  f.shared.adopt({
    ...f.shared.snapshot,
    transparent: true,
    materialShaderId: 'forgeax::sprite',
    passes: ['Forward', 'Overlay'].map((mode) => ({
      name: mode,
      program: { module: 'forgeax::sprite' },
      renderState: { tags: { LightMode: mode }, queue: 3000 },
    })),
  });
  f.dispatch.adopt(f.shared);
  const first = request('Forward', { gpu: false, recordMode: 'transparent' });
  const second = request('Overlay', { gpu: false, passKind: 'forward', recordMode: 'transparent' });
  const prepared = prepareScenePasses([first, second], {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: f.dispatch.materials(),
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: (dispatch, sources) => computeFoldBuckets(f.world, {} as never, dispatch, sources),
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
  });
  const plan = buildDispatchPlan(
    {
      device,
      metrics: { increment: () => {} },
      meshSsboState: { meshSlotCount: 16, materialSlotCount: 16 },
    } as never,
    prepared.rows,
    prepared.dispatch,
    prepared.buckets,
    [],
    undefined,
    false,
    { bindings: [], worlds: f.worlds, frame: f.dispatch.materials() },
    f.scene,
  );
  const buffers = new Map();
  const createBuffer = vi.spyOn(device, 'createBuffer');
  const writeBuffer = vi.spyOn(device.queue, 'writeBuffer');
  const frameState = {
    instanceBuffers: buffers,
    materialBgPerEntity: new Map(),
    instancesBgPerEntity: new Map(),
  };
  const runtime = {
    device,
    errorRegistry: {
      fire: (error: unknown) => {
        throw error;
      },
    },
  };
  const context = {
    runtime: {
      device,
      errorRegistry: {
        fire: (error: unknown) => {
          throw error;
        },
      },
    },
    frameState,
  } as never;
  const work = prepared.finish(plan);
  const resolve = (request: ScenePassRequest) => {
    const draws = work.get(request);
    assert(draws);
    const folds = draws.foldDispatchPlan;
    assert(folds);
    const head = [...folds.headBuckets][0];
    assert(head);
    const row = draws.validatedOrdered[head[0]];
    assert(row);
    return resolveFoldInstanceBuffer(context, head[1], row.renderableIndex);
  };
  try {
    const firstBuffer = resolve(first);
    const secondBuffer = resolve(second);
    expect(firstBuffer).not.toBe(secondBuffer);
    expect(buffers.size).toBe(2);
    assert(plan.foldDispatchPlan);
    const liveKeys = [...retainedFoldInstanceKeys(plan.foldDispatchPlan, plan.validatedOrdered)];
    const residents = [...buffers.values()];
    const firstDraw = work.get(first);
    assert(firstDraw?.foldDispatchPlan);
    const firstFold = [...firstDraw.foldDispatchPlan.headBuckets.values()][0];
    assert(firstFold);
    firstFold.transforms[12] = 73;
    cleanPerFrameCaches(
      runtime as never,
      frameState as never,
      plan.validatedOrdered,
      undefined,
      liveKeys,
    );
    expect(resolve(first)).toBe(firstBuffer);
    expect((writeBuffer.mock.lastCall?.[2] as Float32Array)[12]).toBe(73);
    expect(resolve(second)).toBe(secondBuffer);
    expect(createBuffer).toHaveBeenCalledTimes(2);
    cleanPerFrameCaches(
      runtime as never,
      frameState as never,
      plan.validatedOrdered,
      undefined,
      liveKeys.slice(0, 1),
    );
    expect(buffers.size).toBe(1);
    expect(residents.filter((entry) => entry.buffer.isDestroyed)).toHaveLength(1);
    cleanPerFrameCaches(runtime as never, frameState as never, []);
    expect(buffers.size).toBe(0);
    expect(residents.every((entry) => entry.buffer.isDestroyed)).toBe(true);
    // A subsequent graph/device-state lifetime starts with fresh physical slots.
    expect(resolve(first)).not.toBe(firstBuffer);
    expect(createBuffer).toHaveBeenCalledTimes(3);
  } finally {
    for (const resident of buffers.values()) resident.buffer.destroy();
  }
});

it.each([
  'transparent',
  'oit-residual',
] as const)('sorts actual %s membership even when blended material queue is the default 2000', (recordMode) => {
  const resource = material(1, ['Forward'], { transparent: true });
  const materials = new MaterialFrame(undefined).with(resource);
  const base = receiptRow();
  const mesh = { submeshes: [{ materialSlot: 0 }] } as unknown as MeshGpuHandles;
  const sources = [3, 1, 2].map((z, entityKey) => {
    const matrix = mat4.identity(mat4.create());
    matrix[14] = z;
    return {
      ...base.source,
      entityKey,
      material: resource,
      materials: [resource],
      transform: { ...base.source.transform, world: matrix },
    };
  });
  const world = { transparentSort: { mode: 0, yzAlpha: 1 } } as RenderResourceScope;
  const prepared = prepareScenePasses([request('Forward', { gpu: false, recordMode })], {
    phases: new ViewDrawPhases(),
    scene: {
      plan: { batches: [] } as never,
      slotAt: () => undefined,
      drawSnapshotAt: () => undefined,
      unbatchedSlots: new FrameSet(),
    },
    materials: materials,
    gpu: new GpuDrawSelection([]),
    meshes: new Map(),
    worlds: [world],
    prepareUnbatched: (rows) =>
      rows.map((source, renderableIndex) => ({
        ...base,
        source,
        renderableIndex,
        mesh,
        world,
        meshSlot: renderableIndex,
        renderState: undefined,
        stencilReference: undefined,
      })),
    viewDraws: sources,
    prepareGeometry: (mesh) => mesh,
    fold: () => [],
    lod: (rows) => rows,
    world: world,
    camera: undefined,
  });
  expect(
    prepared.dispatch.map((entry) => prepared.rows[entry.renderableIndex]?.source.entityKey),
  ).toEqual([1, 2, 0]);
});

it('addresses each pass row once under the combined index with its last dispatch overlay', () => {
  const f = fixture(1);
  const first = request('Forward', { gpu: false });
  const second = request('Forward', { gpu: false, passKind: 'temporal' });
  const prepared = prepareScenePasses([first, second], {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: f.dispatch.materials(),
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: () => [],
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
  });
  const perPass = prepared.rows.length / 2;
  expect(perPass).toBeGreaterThan(0);
  expect(prepared.rows.map((row) => row.renderableIndex)).toEqual(
    Array.from({ length: perPass * 2 }, (_, index) => index),
  );
  expect(new Set(prepared.rows).size).toBe(prepared.rows.length);
  for (const entry of prepared.dispatch) {
    const row = prepared.rows[entry.renderableIndex];
    expect(row?.renderState).toBe(entry.renderState);
    expect(row?.stencilReference).toBe(entry.stencilReference);
  }
  expect(prepared.dispatch.map((entry) => entry.renderableIndex).sort((a, b) => a - b)).toEqual(
    Array.from({ length: perPass * 2 }, (_, index) => index),
  );
});

it('retains combined Scene Pass work until a selected phase output or request roster changes', () => {
  const f = fixture(2);
  const phases = new ViewDrawPhases();
  const forward = request('Forward', { gpu: false });
  const draws = {
    slots: f.scene.slotsSnapshot(),
    meshes: f.scene.meshFrame(),
    unavailable: new FrameSet(),
    probe: new ProbeBlendSceneProjection().recordBufferProjection(),
    temporal: undefined,
  };
  const inputs: Parameters<typeof prepareScenePasses>[1] = {
    phases,
    scene: {
      draws,
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: f.dispatch.materials(),
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: () => [],
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
  };
  const first = prepareScenePasses([forward], inputs);
  expect(first.rows.length).toBeGreaterThan(0);
  const quiet = prepareScenePasses([forward], inputs);
  expect(quiet.rows).toBe(first.rows);
  expect(quiet.dispatch).toBe(first.dispatch);
  expect(quiet.buckets).toBe(first.buckets);
  const deferred = request('Deferred', { gpu: false });
  const changed = prepareScenePasses([deferred, forward], inputs);
  expect(changed.rows).not.toBe(first.rows);
  expect(changed.dispatch).not.toBe(first.dispatch);
  expect(changed.rows.every((row, index) => row.renderableIndex === index)).toBe(true);
  expect(prepareScenePasses([deferred, forward], inputs).rows).toBe(changed.rows);
  const source = f.scene.slotAt(0)?.snapshot;
  assert(source);
  const pose = new Float32Array(source.transform.world);
  pose[12] = 23;
  f.topology.apply(f.scene.apply([{ kind: 'update', worldId: 0, entityKey: 0, world: pose }]));
  const moved = prepareScenePasses([deferred, forward], {
    ...inputs,
    scene: {
      ...inputs.scene,
      plan: f.topology.query(f.topology.sourcePlan(), undefined),
      draws: { ...draws, slots: f.scene.slotsSnapshot() },
    },
  });
  // A pose edit may retain the phase roster; its live row must carry the new source.
  expect(moved.rows.length).toBe(changed.rows.length);
  expect(moved.rows.find((row) => row.source.entityKey === 0)?.source.transform.world[12]).toBe(23);
});

it('skips folding source projection for an owned scene without Sprite demand', () => {
  const f = fixture(128);
  let materials = f.dispatch.materials();
  for (const resource of [f.shared, f.noLod, f.deferredOnly, f.medium])
    materials = materials.with(resource, undefined, {
      ...resource.snapshot,
      immutableValues: true,
    });
  const fold = vi.fn(() => {
    throw new Error('non-Sprite frame requested fold rows');
  });
  const inputs = {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials,
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh: MeshGpuHandles) => mesh,
    fold,
    lod: (rows: readonly ValidatedRenderable[]) => rows,
    world: f.world,
    camera: undefined,
  };
  const req = request('Forward', { gpu: false });
  const first = prepareScenePasses([req], inputs);
  expect(first.rows.length).toBeGreaterThan(128);
  expect(fold).not.toHaveBeenCalled();
  const unrelated = new MaterialResource({ ...f.shared.snapshot, immutableValues: true });
  const next = prepareScenePasses([req], { ...inputs, materials: materials.with(unrelated, 0) });
  expect(next).toBe(first);
  expect(fold).not.toHaveBeenCalled();
});

it('refreshes Sprite fold admission on parameter-only adoption with retained Passes', () => {
  const f = fixture(2);
  f.shared.adopt({
    ...f.shared.snapshot,
    materialShaderId: 'forgeax::sprite',
    transparent: true,
    immutableValues: true,
    paramSnapshot: { region: [0, 0, 1, 1] },
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::sprite' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 3000 },
      },
    ],
  });
  f.dispatch.adopt(f.shared);
  let materials = f.dispatch.materials();
  for (const resource of [f.noLod, f.deferredOnly, f.medium])
    materials = materials.with(resource, undefined, {
      ...resource.snapshot,
      immutableValues: true,
    });
  const fold = vi.fn((dispatch, rows) => computeFoldBuckets(f.world, {} as never, dispatch, rows));
  const inputs = {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials,
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh: MeshGpuHandles) => mesh,
    fold,
    lod: (rows: readonly ValidatedRenderable[]) => rows,
    world: f.world,
    camera: undefined,
  };
  const req = request('Forward', { gpu: false, recordMode: undefined, passKind: 'forward' });
  const first = prepareScenePasses([req], inputs);
  expect(first.buckets.map((bucket) => bucket.bucketSize)).toEqual([2]);
  const changed = materials.with(f.shared, undefined, {
    ...f.shared.snapshot,
    paramSnapshot: { region: [0, 0, 0.5, 0.5] },
  });
  expect(changed.get(f.shared)?.passes).toBe(materials.get(f.shared)?.passes);
  const second = prepareScenePasses([req], { ...inputs, materials: changed });
  expect(second.dispatch).not.toEqual([]);
  expect(fold).toHaveBeenCalledTimes(2);
  const unrelated = changed.with(f.medium, undefined, {
    ...f.medium.snapshot,
    immutableValues: true,
    roughness: 0.2,
  });
  expect(prepareScenePasses([req], { ...inputs, materials: unrelated })).toBe(second);
  expect(fold).toHaveBeenCalledTimes(2);
  const noSprite = changed.with(f.shared, undefined, { ...f.shared.snapshot, transparent: false });
  const third = prepareScenePasses([req], { ...inputs, materials: noSprite });
  expect(third.buckets).toEqual([]);
});

it('refreshes transmission slicing when only an owned scalar value changes', () => {
  const f = fixture(2);
  let materials = f.dispatch.materials();
  for (const resource of [f.shared, f.noLod, f.deferredOnly, f.medium])
    materials = materials.with(resource, undefined, {
      ...resource.snapshot,
      immutableValues: true,
      ...(resource === f.shared ? { transparent: true } : {}),
    });
  const inputs = {
    phases: new ViewDrawPhases(),
    scene: {
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials,
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh: MeshGpuHandles) => mesh,
    fold: () => [],
    lod: (rows: readonly ValidatedRenderable[]) => rows,
    world: f.world,
    camera: undefined,
  };
  const req = request('Forward', {
    gpu: false,
    recordMode: 'translucent-before-transmission',
    passKind: 'forward',
  });
  const first = prepareScenePasses([req], inputs);
  const accepted = materials.get(f.shared);
  assert(accepted);
  const transmitting = materials.with(f.shared, undefined, {
    ...accepted.snapshot,
    paramSnapshot: { transmission: 1 },
  });
  const second = prepareScenePasses([req], { ...inputs, materials: transmitting });
  expect(transmitting.get(f.shared)?.passes).toBe(accepted.passes);
  expect(second).not.toBe(first);
  expect(second.dispatch.length).toBeLessThan(first.dispatch.length);
});

it('does not keep superseded preparations through the current finish method', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const f = fixture(2);
  const phases = new ViewDrawPhases();
  const forward = request('Forward', { gpu: false });
  const draws = {
    slots: f.scene.slotsSnapshot(),
    meshes: f.scene.meshFrame(),
    unavailable: new FrameSet(),
    probe: new ProbeBlendSceneProjection().recordBufferProjection(),
    temporal: undefined,
  };
  const inputs: Parameters<typeof prepareScenePasses>[1] = {
    phases,
    scene: {
      draws,
      plan: f.plan,
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: new FrameSet(),
    },
    materials: f.dispatch.materials(),
    gpu: f.gpu,
    meshes: f.meshes,
    worlds: f.worlds,
    prepareUnbatched: () => [],
    viewDraws: [],
    prepareGeometry: (mesh) => mesh,
    fold: () => [],
    lod: (rows) => rows,
    world: f.world,
    camera: undefined,
  };
  const retired = (() => new WeakRef(prepareScenePasses([forward], inputs)))();
  const deferred = request('Deferred', { gpu: false });
  const current = prepareScenePasses([deferred, forward], inputs);
  expect(current.rows.length).toBeGreaterThan(0);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  gc();
  expect(retired.deref()).toBeUndefined();
  expect(prepareScenePasses([deferred, forward], inputs)).toBe(current);
});
