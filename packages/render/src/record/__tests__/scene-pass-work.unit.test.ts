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
import { RenderScene } from '../../scene/render-scene';
import { createTemporalView } from '../../temporal/view';
import { buildDispatchPlan, computeFoldBuckets } from '../fold-buckets';
import { resolveFoldInstanceBuffer } from '../fold-instance-buffer';
import { makeZeroCameraFallbackSnapshot, type ValidatedRenderable } from '../frame-snapshot';
import { computeProjectionMatrix } from '../helpers';
import { selectMainPassMaterials } from '../main-pass';
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
        planned.materialSlots[selected.materialSlotIndices[index]?.[0] ?? -1]?.materialHandle,
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
  const frame = f.dispatch.materials();
  const pass = request('Forward', { gpuFilter: 'forward-only-opaque' });
  f.shared.adopt({ ...f.shared.snapshot, transparent: true });
  f.dispatch.adopt(f.shared);
  const prepared = prepareScenePasses([pass], {
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
  expect(selectMainPassMaterials(context, pass.selector, 'opaque')?.size).toBe(1);
  expect(context.gpuDrivenSelection).toBeUndefined();
  expect(() => scenePassContext(context, request('Forward'))).toThrow('prepared draw work');
});

it('uses current camera admission before CPU validation while captures keep their own roster', () => {
  const f = fixture(2);
  const display = request('Forward', { gpu: false });
  const capture = request('Forward', { gpu: false, capture: true });
  const visible = vi.fn((source) => source.entityKey === 1);
  const prepared = prepareScenePasses([display, capture], {
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

it('allocates separate fold instance buffers for the same source in different graph nodes', async () => {
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
  const context = {
    runtime: {
      device,
      errorRegistry: {
        fire: (error: unknown) => {
          throw error;
        },
      },
    },
    frameState: { instanceBuffers: buffers },
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
    expect(resolve(first)).not.toBe(resolve(second));
    expect(buffers.size).toBe(2);
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
