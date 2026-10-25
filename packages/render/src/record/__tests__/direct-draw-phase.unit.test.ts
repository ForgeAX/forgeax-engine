import { mat4, vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../../device/gpu-residency';
import type { BatchExecution } from '../../gpu-driven/batch-execution';
import { BatchTopology, type GpuDrivenBatchBinding } from '../../gpu-driven/batch-topology';
import type { BatchExecutions } from '../../gpu-driven/material-artifacts';
import { disposeInstanceBuffers } from '../../instance-buffer-cache';
import { MaterialResource } from '../../material-resource';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { RenderableSnapshot } from '../../render-system-extract';
import type { FrameList } from '../../scene/frame-list';
import { MaterialFrame } from '../../scene/material-dispatch';
import { RenderScene } from '../../scene/render-scene';
import { DirectDrawPhase, type DirectDrawScene } from '../direct-draw-phase';
import type { ValidatedRenderable } from '../frame-snapshot';
import { resolveGeometryInstanceBuffer } from '../main-pass-geometry';
import { materialGeometry } from '../material-geometry';
import type { _InternalRenderPipelineContext } from '../render-context';

const material = new MaterialResource({
  materialHandle: 1,
  materialShaderId: 'direct-fixture',
  passes: [],
  baseColor: vec3.create(1, 1, 1),
  metallic: 0,
  roughness: 1,
});
const mesh = {
  submeshes: [0, 1, 2].map((materialSlot) => ({
    materialSlot,
    topology: 'triangle-list',
    vertexCount: 3,
    indexCount: 3,
    indexOffset: materialSlot * 3,
  })),
} as unknown as MeshGpuHandles;
const worlds = [{ identity: 'direct-world' }] as RenderResourceScope[];
const direct: BatchExecution = {
  route: 'direct',
  material: material.snapshot,
  pass: { kind: 'shadow', shaderId: 'direct-fixture' },
};
const gpu = { route: 'gpu' } as BatchExecution;

function source(entityKey: number, drawIndices = [0]): RenderableSnapshot {
  return {
    worldId: 0,
    entityKey,
    assetHandle: 2,
    material,
    materials: [material, material, material],
    materialBindingSources: ['renderer-override'],
    transform: { world: mat4.identity(mat4.create()) },
    localAabb: Float32Array.of(-1, -1, -1, 1, 1, 1),
    gpuDrivenDraws: drawIndices.map((drawItemIndex) => {
      const draw = {
        kind: 'indexed' as const,
        first: drawItemIndex * 3,
        count: 3,
        baseVertex: 0,
        topology: 'triangle-list' as const,
      };
      return {
        ...draw,
        drawItemIndex,
        materialSlot: drawItemIndex,
        pipelineClass: 'source',
        materialResourceClass: 'source',
        geometry: {
          receipt: {
            identity: 'triangle',
            vertexInputs: [],
            topology: 'triangle-list',
            indexed: true,
          },
          draw,
          deformation: 'rigid',
        },
      };
    }),
  };
}

/** One cold sync of a fresh phase, as one frame's complete direct roster. */
function directDrawRows(
  scene: DirectDrawScene,
  select: (
    binding: GpuDrivenBatchBinding,
  ) => import('../../render-system-extract').MaterialSnapshot | undefined,
  meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
  scopes: readonly RenderResourceScope[],
  pass: string,
  prepareUnbatched: (sources: FrameList<RenderableSnapshot>) => readonly ValidatedRenderable[],
  viewDraws: FrameList<RenderableSnapshot> = [],
  prepareGeometry?: (
    mesh: MeshGpuHandles,
    material: import('../../render-system-extract').MaterialSnapshot,
  ) => MeshGpuHandles,
): readonly ValidatedRenderable[] {
  return new DirectDrawPhase().sync({
    scene,
    selection: [],
    select,
    meshes,
    worlds: scopes,
    shadow: pass === 'shadow',
    materials: undefined,
    prepareUnbatched,
    viewDraws,
    prepareGeometry,
    lod: (rows) => rows,
  }).rows;
}

function setup(sources: FrameList<RenderableSnapshot>) {
  const scene = new RenderScene();
  scene.apply(
    sources.map((snapshot) => ({
      kind: 'update',
      worldId: 0,
      entityKey: snapshot.entityKey,
      snapshot,
    })),
  );
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const executions = new Map<GpuDrivenBatchBinding, BatchExecutions>();
  const meshes = new Map<GpuDrivenBatchBinding, MeshGpuHandles>();
  for (const batch of topology.query(topology.sourcePlan(), undefined).batches) {
    assert(batch.binding);
    executions.set(batch.binding, { forward: direct, shadow: direct });
    meshes.set(batch.binding, mesh);
  }
  const select = (binding: GpuDrivenBatchBinding) => {
    const execution = executions.get(binding)?.shadow;
    assert(execution);
    return execution.route === 'direct' ? execution.material : undefined;
  };
  return { scene, topology, executions, meshes, select };
}

it.each([1, 10_000, 50_000])('visits only direct members beside %i GPU instances', (count) => {
  const f = setup([
    ...Array.from({ length: count }, (_, index) => source(index)),
    source(count, [2, 1]),
  ]);
  const plan = f.topology.query(f.topology.sourcePlan(), undefined);
  const batches = plan.batches.map((batch) => {
    assert(batch.binding);
    if (batch.binding.drawItemIndex === 0) {
      f.executions.set(batch.binding, { forward: gpu, shadow: gpu });
      return {
        ...batch,
        get members(): never {
          throw new Error('GPU members must not be visited');
        },
        get candidates(): never {
          throw new Error('GPU candidates must not be visited');
        },
      };
    }
    return batch;
  });
  const slotAt = vi.fn(f.scene.slotAt);
  const unbatched = vi.fn(() => []);
  const rows = directDrawRows(
    {
      plan: { ...plan, batches },
      slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: f.topology.unbatchedSlots,
    },
    f.select,
    f.meshes,
    worlds,
    'shadow',
    unbatched,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.source.entityKey).toBe(count);
  expect(rows[0]?.submeshIndices).toEqual([2, 1]);
  expect(slotAt).toHaveBeenCalledTimes(1);
  expect(unbatched).not.toHaveBeenCalled();
});

it('uses fixed executions, preserves source instances and rejects recycled slots', () => {
  const value = source(7);
  const f = setup([value]);
  const state = {
    plan: f.topology.query(f.topology.sourcePlan(), undefined),
    slotAt: f.scene.slotAt,
    drawSnapshotAt: f.scene.drawSnapshotAt,
    unbatchedSlots: f.topology.unbatchedSlots,
  };
  material.adopt({ ...material.snapshot, passes: [] });
  expect(directDrawRows(state, f.select, f.meshes, worlds, 'shadow', () => [])[0]?.source).toBe(
    f.scene.slot(0, 7)?.snapshot,
  );
  f.scene.apply([
    { kind: 'remove', worldId: 0, entityKey: 7 },
    { kind: 'update', worldId: 0, entityKey: 8, snapshot: source(8) },
  ]);
  expect(() => directDrawRows(state, f.select, f.meshes, worlds, 'shadow', () => [])).toThrow(
    'live generation',
  );
});

it('publishes unbatched additions/removals even when GPU plan revision does not change', () => {
  const f = setup([]);
  const before = f.topology.unbatchedSlots;
  const revision = f.topology.query(f.topology.sourcePlan(), undefined).revision;
  const value = { ...source(3), gpuDrivenDraws: [] };
  f.topology.apply(f.scene.apply([{ kind: 'update', worldId: 0, entityKey: 3, snapshot: value }]));
  const added = f.topology.unbatchedSlots;
  expect([...before]).toEqual([]);
  expect([...added]).toEqual([f.scene.slot(0, 3)?.slot]);
  expect(f.topology.query(f.topology.sourcePlan(), undefined).revision).toBe(revision);
  expect(f.topology.unbatchedSlots).toBe(added);
  f.topology.apply(f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 3 }]));
  expect([...f.topology.unbatchedSlots]).toEqual([]);
  expect(added.size).toBe(1);
});

it('prepares only unbatched geometry and keeps Terrain sections distinct', () => {
  const root = {
    ...source(1),
    gpuDrivenDraws: [],
    terrain: {} as NonNullable<RenderableSnapshot['terrain']>,
  };
  const morph = { ...source(2), gpuDrivenDraws: [] };
  const invisible = { ...source(3), gpuDrivenDraws: [], authorVisible: false };
  const f = setup([root, morph, invisible]);
  const sections = [0, 1].map((index) => ({
    ...root,
    assetHandle: index + 10,
    transform: { world: Float32Array.of(index) },
  }));
  const prepare = vi.fn((sources: FrameList<RenderableSnapshot>) =>
    sources.map(
      (source, renderableIndex): ValidatedRenderable => ({
        source,
        mesh,
        renderableIndex,
        meshSlot: renderableIndex,
        renderState: undefined,
        stencilReference: undefined,
      }),
    ),
  );
  const rows = directDrawRows(
    {
      plan: f.topology.query(f.topology.sourcePlan(), undefined),
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: f.topology.unbatchedSlots,
    },
    f.select,
    f.meshes,
    worlds,
    'shadow',
    prepare,
    sections,
  );
  expect(rows.map((row) => row.source.entityKey)).toEqual([2, 1, 1]);
  expect(rows.map((row) => row.source.assetHandle)).toEqual([2, 10, 11]);
  expect(rows.map((row) => row.renderableIndex)).toEqual([0, 1, 2]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0]?.[0]).toHaveLength(3);
});

it.each([
  'shadow-first',
  'main-first',
])('retains previous instance transforms through %s preparation', async (order) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } }],
    })
    .unwrap();
  const c = {
    runtime: {
      device,
      errorRegistry: {
        fire: (error: unknown) => {
          throw error;
        },
      },
    },
    pipelineState: { instancesBindGroupLayout: layout },
    frameState: { instanceBuffers: new Map(), instancesBgShared: new WeakMap() },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as _InternalRenderPipelineContext;
  const first: RenderableSnapshot = {
    ...source(7),
    instances: {
      transforms: mat4.identity(mat4.create()),
      instanceCount: 1,
      cacheKey: 1,
      archVersion: 0,
      revision: 0,
      generations: Uint32Array.of(7),
    },
  };
  const f = setup([first]);
  f.scene.setTemporalTracking(true);
  f.scene.commitSubmission(f.scene.captureSubmission(f.scene.materialize()));
  const transform = mat4.identity(mat4.create());
  transform[12] = 10;
  assert(first.instances);
  const next = { ...first, instances: { ...first.instances, transforms: transform, revision: 1 } };
  f.topology.apply(f.scene.apply([{ kind: 'update', worldId: 0, entityKey: 7, snapshot: next }]));
  const shadow = directDrawRows(
    {
      plan: f.topology.query(f.topology.sourcePlan(), undefined),
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: f.topology.unbatchedSlots,
    },
    f.select,
    f.meshes,
    worlds,
    'shadow',
    () => [],
  )[0];
  assert(shadow);
  const mainSource = f.scene
    .materializeTemporal({ hits: 0, misses: 0 }, new MaterialFrame(undefined).with(first.material))
    .at(0);
  assert(mainSource);
  const main = { ...shadow, source: mainSource };
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  try {
    for (const row of order === 'shadow-first' ? [shadow, main] : [main, shadow, main])
      resolveGeometryInstanceBuffer(c, row, [], false);
    expect(writes).toHaveBeenCalledTimes(1);
    const payload = writes.mock.calls[0]?.[2] as Float32Array;
    expect(payload[12]).toBe(10);
    expect(payload[28]).toBe(0);
  } finally {
    disposeInstanceBuffers(c.frameState.instanceBuffers);
  }
});

it('does not revive a source that the Scene drawable owner withheld', () => {
  const f = setup([source(1), { ...source(2), gpuDrivenDraws: [] }]);
  const prepare = vi.fn(() => []);
  const rows = directDrawRows(
    {
      plan: f.topology.query(f.topology.sourcePlan(), undefined),
      slotAt: f.scene.slotAt,
      drawSnapshotAt: () => undefined,
      unbatchedSlots: f.topology.unbatchedSlots,
    },
    f.select,
    f.meshes,
    worlds,
    'shadow',
    prepare,
  );
  expect(rows).toEqual([]);
  expect(prepare).not.toHaveBeenCalled();
});

it('prepares nine-slice geometry once per shared direct binding from its fixed material', () => {
  const f = setup(Array.from({ length: 1000 }, (_, index) => source(index)));
  const base = { ...mesh, submeshes: mesh.submeshes.slice(0, 1) };
  const sliced = {
    ...base,
    submeshes: [{ ...base.submeshes[0], indexCount: 54 }],
  } as unknown as MeshGpuHandles;
  const fixed = {
    ...material.snapshot,
    materialShaderId: 'sha256:sprite-lit-cooked',
    passes: [{ name: 'Forward', program: { module: 'forgeax_material::sprite-lit' } }],
    paramSnapshot: { slicesAndMode: [0.1, 0.1, 0.1, 0.1] },
  };
  for (const batch of f.topology.query(f.topology.sourcePlan(), undefined).batches) {
    assert(batch.binding);
    f.executions.set(batch.binding, { forward: direct, shadow: { ...direct, material: fixed } });
    f.meshes.set(batch.binding, base);
  }
  const prepare = vi.fn(() => sliced);
  const rows = directDrawRows(
    {
      plan: f.topology.query(f.topology.sourcePlan(), undefined),
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: f.topology.unbatchedSlots,
    },
    f.select,
    f.meshes,
    worlds,
    'shadow',
    () => [],
    [],
    (mesh, material) => materialGeometry(mesh, material, prepare),
  );
  expect(rows).toHaveLength(1000);
  expect(rows.every((row) => row.mesh === sliced)).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(
    materialGeometry(base, { ...fixed, paramSnapshot: { slicesAndMode: [0, 0, 0, 0] } }, prepare),
  ).toBe(base);
  expect(() => materialGeometry(mesh, fixed, prepare)).toThrow('one source submesh');
});

it('records native view geometry without re-admitting its non-drawing source root', () => {
  const { assetHandle: _asset, ...base } = source(9);
  const root = {
    ...base,
    gpuDrivenDraws: [],
    glyph: {} as NonNullable<RenderableSnapshot['glyph']>,
  };
  const draw = { ...root, generatedMesh: {} as NonNullable<RenderableSnapshot['generatedMesh']> };
  const f = setup([root]);
  const prepare = vi.fn((sources: FrameList<RenderableSnapshot>) =>
    sources.map((source, renderableIndex) => ({
      source,
      mesh,
      renderableIndex,
      meshSlot: renderableIndex,
      renderState: undefined,
      stencilReference: undefined,
    })),
  );
  const rows = directDrawRows(
    {
      plan: f.topology.query(f.topology.sourcePlan(), undefined),
      slotAt: f.scene.slotAt,
      drawSnapshotAt: f.scene.drawSnapshotAt,
      unbatchedSlots: f.topology.unbatchedSlots,
    },
    f.select,
    f.meshes,
    worlds,
    'forward',
    prepare,
    [draw],
  );
  expect(rows.map((row) => row.source)).toEqual([draw]);
  expect(prepare).toHaveBeenCalledWith([draw]);
});
