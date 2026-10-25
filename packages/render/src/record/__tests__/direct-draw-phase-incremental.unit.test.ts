import { mat4 } from '@forgeax/engine-math';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { assert, expect, it } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import type { MeshGpuHandles } from '../../device/gpu-residency';
import { BatchTopology, type GpuDrivenBatchBinding } from '../../gpu-driven/batch-topology';
import { MaterialResource } from '../../material-resource';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { CameraSnapshot } from '../../render-contract';
import type { MaterialSnapshot, RenderableSnapshot } from '../../render-system-extract';
import type { DrawEvidence } from '../../scene/draw-evidence';
import { FrameSet } from '../../scene/frame-set';
import { MaterialDispatch } from '../../scene/material-dispatch';
import type { ProbeBlendBufferProjection } from '../../scene/probe-blend';
import { RenderScene } from '../../scene/render-scene';
import { TRANSPARENT_SORT_MODE_DISTANCE } from '../../systems/transparent-sort-config';
import { type DirectDrawInput, DirectDrawPhase, directDrawPhase } from '../direct-draw-phase';

const blend = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

function material(handle: number, transparent: boolean): MaterialResource {
  return new MaterialResource({
    ...receiptRow().source.material.snapshot,
    materialHandle: handle,
    transparent,
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: transparent
          ? { tags: { LightMode: 'Forward' }, queue: 3000, blend }
          : { tags: { LightMode: 'Forward' } },
      },
    ],
  });
}

const opaque = material(1, false);
const other = material(2, false);
const glass = material(3, true);
const probe = {
  sourceIdentity: {},
  revision: 0,
  baseRevision: 0,
  capacity: 1,
  records: [],
  dirtyRecords: [],
  removedCacheKeys: [],
} as unknown as ProbeBlendBufferProjection;
const mesh = {
  submeshes: Array.from({ length: 3 }, () => ({ materialSlot: 0 })),
} as unknown as MeshGpuHandles;
const worlds = [{ identity: 'binned-world' }] as unknown as RenderResourceScope[];

function source(entityKey: number, resource: MaterialResource, z = entityKey): RenderableSnapshot {
  const base = receiptRow().source;
  const world = mat4.identity(mat4.create());
  world[14] = z;
  return {
    ...base,
    entityKey,
    material: resource,
    materials: [resource],
    transform: { world },
    gpuDrivenDraws: base.gpuDrivenDraws?.slice(0, 1) ?? [],
  };
}

function eye(z: number): CameraSnapshot {
  return { position: new Float32Array([0, 0, z]) } as unknown as CameraSnapshot;
}

/** A Scene with `opaqueCount` opaque and `glassCount` blended rows, all CPU-drawn. */
function fixture(opaqueCount: number, glassCount: number) {
  const scene = new RenderScene();
  const topology = new BatchTopology();
  const dispatch = new MaterialDispatch();
  const write = (sources: readonly RenderableSnapshot[]) => {
    topology.apply(
      scene.apply(
        sources.map((snapshot) => ({
          kind: 'update' as const,
          worldId: 0,
          entityKey: snapshot.entityKey,
          snapshot,
        })),
      ),
    );
    for (const snapshot of sources) {
      const record = scene.slot(0, snapshot.entityKey);
      assert(record);
      dispatch.bind(record.slot, record.snapshot);
    }
  };
  write([
    ...Array.from({ length: opaqueCount }, (_, index) => source(index, opaque)),
    ...Array.from({ length: glassCount }, (_, index) => source(opaqueCount + index, glass)),
  ]);
  const meshes = new Map<GpuDrivenBatchBinding, MeshGpuHandles>();
  const input = (camera = eye(0)): DirectDrawInput => {
    const plan = topology.sourcePlan();
    for (const batch of plan.batches) if (batch.binding) meshes.set(batch.binding, mesh);
    const materials = dispatch.materials();
    const draws: DrawEvidence = {
      slots: scene.slotsSnapshot(),
      meshes: scene.meshFrame(),
      unavailable: new FrameSet(),
      probe,
      temporal: undefined,
    };
    return {
      scene: {
        plan,
        slotAt: scene.slotAt,
        drawSnapshotAt: scene.drawSnapshotAt,
        unbatchedSlots: topology.unbatchedSlots,
        draws,
      },
      selection: [],
      select: (binding): MaterialSnapshot | undefined => materials.get(binding.material)?.snapshot,
      meshes,
      worlds,
      shadow: false,
      materials,
      prepareUnbatched: () => [],
      viewDraws: [],
      lod: (rows) => rows,
      entries: { selector: undefined },
      sort: { mode: TRANSPARENT_SORT_MODE_DISTANCE, yzAlpha: 1, camera, all: false },
    };
  };
  return { scene, dispatch, write, input };
}

const order = (output: ReturnType<DirectDrawPhase['sync']>) =>
  output.dispatch.map((entry) => entry.entityIndex as number);

it('refreshes retained rows even when no authored pass enters a bin', () => {
  const f = fixture(1, 0);
  const phase = new DirectDrawPhase();
  const input = (): DirectDrawInput => ({
    ...f.input(),
    entries: { selector: { LightMode: ['Deferred'] } },
  });
  const first = phase.sync(input());
  expect(first.dispatch).toHaveLength(0);
  expect(first.rows).toHaveLength(1);
  f.write([source(0, opaque, 9)]);
  const next = phase.sync(input());
  expect(next.rows[0]?.source.transform.world[14]).toBe(9);
  expect(next).not.toBe(first);
  expect(phase.sync(input())).toBe(next);
});

it('keeps a steady frame at zero phase work and returns the same output', () => {
  const f = fixture(2_000, 200);
  const phase = new DirectDrawPhase();
  const first = phase.sync(f.input());
  expect(first.rows).toHaveLength(2_200);
  const work = { ...phase.work };
  const bins = { ...phase.binWork };
  const sort = { ...phase.sortWork };
  expect(phase.sync(f.input())).toBe(first);
  expect(phase.work.rebuilt).toBe(work.rebuilt);
  expect(phase.work.emitted).toBe(work.emitted);
  expect(phase.binWork).toEqual(bins);
  expect(phase.sortWork.changed).toBe(sort.changed);
});

it('updates only the D changed rows of a steady frame (O(D) bin and sort operations)', () => {
  const f = fixture(2_000, 200);
  const phase = new DirectDrawPhase();
  phase.sync(f.input());
  const work = { ...phase.work };
  const bins = { ...phase.binWork };
  const sort = { ...phase.sortWork };
  // Four opaque and four blended rows move; the blended ones overtake the camera's far end.
  f.write([
    ...[3, 500, 1_200, 1_999].map((entity) => source(entity, opaque, entity + 0.5)),
    ...[2_000, 2_050, 2_100, 2_199].map((entity) => source(entity, glass, -10_000 - entity)),
  ]);
  const output = phase.sync(f.input());
  expect(phase.work.rebuilt - work.rebuilt).toBe(8);
  expect(phase.binWork.dequeued - bins.dequeued).toBe(8);
  expect(phase.binWork.enqueued - bins.enqueued).toBe(8);
  expect(phase.binWork.bins).toBe(bins.bins);
  expect(phase.sortWork.changed - sort.changed).toBe(8);
  expect(phase.work.cold).toBe(work.cold);
  // The retained order equals a fresh phase's order over the same frame.
  expect(order(output)).toEqual(order(new DirectDrawPhase().sync(f.input())));
  // DISTANCE draws back to front: the moved rows are now the farthest.
  expect(order(output).slice(2_000, 2_004)).toEqual([2_199, 2_100, 2_050, 2_000]);
});

it('dequeues a row from its old bin before it enqueues into the new one', () => {
  const f = fixture(100, 10);
  const phase = new DirectDrawPhase();
  phase.sync(f.input());
  const bins = { ...phase.binWork };
  // One opaque row changes material (bin key); one blended row becomes opaque.
  f.write([source(7, other), source(105, opaque)]);
  const output = phase.sync(f.input());
  expect(phase.binWork.dequeued - bins.dequeued).toBe(2);
  expect(phase.binWork.enqueued - bins.enqueued).toBe(2);
  expect(phase.binWork.bins - bins.bins).toBe(1);
  expect(output.dispatch.filter((entry) => entry.entityIndex === 7)).toHaveLength(1);
  expect(order(output)).toEqual(order(new DirectDrawPhase().sync(f.input())));
  expect(order(output).indexOf(105)).toBeLessThan(100);
});

it('keeps views independent: each view orders its own camera from its own diffs', () => {
  const f = fixture(0, 50);
  const near = {};
  const far = {};
  const front = directDrawPhase(near, f);
  const back = directDrawPhase(far, f);
  expect(directDrawPhase(near, f)).toBe(front);
  const a = front.sync(f.input(eye(-100)));
  const b = back.sync(f.input(eye(100)));
  expect(order(a)).toEqual([...order(b)].reverse());
  const before = { ...back.work };
  front.sync(f.input(eye(-100)));
  expect(back.work).toEqual(before);
  // z=50 is the farthest row from z=-100 and the nearest from z=100.
  const work = { ...front.work };
  f.write([source(20, glass, 50)]);
  expect(order(front.sync(f.input(eye(-100)))).at(0)).toBe(20);
  expect(order(back.sync(f.input(eye(100)))).at(-1)).toBe(20);
  expect(front.work.rebuilt - work.rebuilt).toBe(1);
});

it('re-reads only flipped rows when camera admission evidence changes', () => {
  const f = fixture(1_000, 0);
  const phase = new DirectDrawPhase();
  const residual = FrameSet.from(Array.from({ length: 1_000 }, (_, slot) => slot));
  let hidden = new FrameSet();
  const frusta = {};
  const admitted = () => {
    const input = f.input();
    const slotOf = (entity: number) => f.scene.slot(0, entity)?.slot ?? -1;
    return {
      ...input,
      visible: (row: RenderableSnapshot) => !hidden.has(slotOf(row.entityKey)),
      admission: { hidden, residual, frusta },
    };
  };
  expect(phase.sync(admitted()).rows).toHaveLength(1_000);
  const work = { ...phase.work };
  hidden = hidden.with(f.scene.slot(0, 10)?.slot ?? -1).with(f.scene.slot(0, 11)?.slot ?? -1);
  const output = phase.sync(admitted());
  expect(phase.work.rebuilt - work.rebuilt).toBe(2);
  expect(output.rows).toHaveLength(998);
});

it('re-judges residency only for batches of the current plan', () => {
  const f = fixture(10, 0);
  const phase = new DirectDrawPhase();
  phase.sync(f.input());
  // A new material binding retires the old batch; the resident table is rebuilt
  // without the retired binding in the same frame.
  for (let entity = 0; entity < 10; entity++) f.write([source(entity, other)]);
  const input = f.input();
  const live = new Map([...input.meshes].filter(([binding]) => binding.material === other));
  const output = phase.sync({ ...input, meshes: live });
  expect(output.rows).toHaveLength(10);
  expect(order(output)).toEqual(order(new DirectDrawPhase().sync({ ...input, meshes: live })));
});

it('replays unchanged bins as retained bundles while rows enter another bin', async () => {
  const { rhi } = await import('@forgeax/engine-rhi-null');
  const { RenderBundleCache } = await import('../render-bundle-cache');
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const pipelines = new Map(
    [opaque, other, glass].map((resource) => [
      resource.snapshot.materialHandle,
      device.createRenderPipeline({} as never).unwrap(),
    ]),
  );
  const group = device
    .createBindGroup({
      layout: device.createBindGroupLayout({ entries: [] }).unwrap(),
      entries: [],
    })
    .unwrap();
  // One draw per dispatch entry in phase order, addressed by its stable slot.
  const record = (output: ReturnType<DirectDrawPhase['sync']>) => (pass: RhiRenderPassEncoder) => {
    let pipeline: unknown;
    for (const [index, entry] of output.dispatch.entries()) {
      const next = pipelines.get(entry.materialHandle);
      if (next !== pipeline) {
        pipeline = next;
        pass.setPipeline(next as never);
      }
      const row = output.entryRows[index];
      pass.setBindGroup(2, group, [(row?.sceneSlot?.slot ?? 0) * 256]);
      pass.draw(3);
    }
  };
  const f = fixture(600, 0);
  f.write(Array.from({ length: 300 }, (_, index) => source(600 + index, other)));
  const phase = new DirectDrawPhase();
  const cache = new RenderBundleCache({ colorFormats: [] });
  const frame = () => {
    const counters = { hits: 0, misses: 0 };
    const encoder = device.createCommandEncoder().unwrap();
    cache.encode(
      device,
      encoder.beginRenderPass({ colorAttachments: [] }),
      record(phase.sync(f.input())),
      counters,
    );
    return counters;
  };
  for (let warm = 0; warm < 3; warm++) frame();
  expect(frame()).toEqual({ hits: 8, misses: 0 });
  // 100 rows enter the opaque bin: it grows from five to six segments, moving
  // every later segment ordinal, while the `other` bin is unchanged.
  f.write(Array.from({ length: 100 }, (_, index) => source(1_000 + index, opaque)));
  const entered = frame();
  // Four leading opaque segments and all three `other` segments replay.
  expect(entered.hits).toBe(7);
});

it('re-resolves retained morph streams every sync and adopts a re-created stream', () => {
  const f = fixture(4, 0);
  const morphed = source(2, opaque);
  f.write([{ ...morphed, morph: {} as never }]);
  const phase = new DirectDrawPhase();
  let stream = { ...mesh } as MeshGpuHandles;
  const resolved: number[] = [];
  const input = (): DirectDrawInput => ({
    ...f.input(),
    prepareGeometry: (base, _material, row) => {
      if (row === undefined) return base;
      resolved.push(row.entityKey);
      return stream;
    },
  });
  const first = phase.sync(input());
  const rowOf = (output: ReturnType<DirectDrawPhase['sync']>) =>
    output.rows.find((row) => row.source.entityKey === 2);
  expect(rowOf(first)?.mesh).toBe(stream);
  expect(phase.derivesGeometry).toBe(true);
  const work = { ...phase.work };
  resolved.length = 0;
  // A steady sync rebuilds nothing but keeps the morph output alive.
  expect(phase.sync(input())).toBe(first);
  expect(resolved).toEqual([2]);
  expect(phase.work.rebuilt).toBe(work.rebuilt);
  stream = { ...mesh } as MeshGpuHandles;
  expect(rowOf(phase.sync(input()))?.mesh).toBe(stream);
});
