import { mat4 } from '@forgeax/engine-math';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { assert, expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import type { MeshGpuHandles } from '../../device/gpu-residency';
import { BatchTopology, type GpuDrivenBatchBinding } from '../../gpu-driven/batch-topology';
import { MaterialResource } from '../../material-resource';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { CameraSnapshot } from '../../render-contract';
import type { MaterialSnapshot, RenderableSnapshot } from '../../render-system-extract';
import type { DrawEvidence } from '../../scene/draw-evidence';
import { FrameSet } from '../../scene/frame-set';
import { MaterialDispatch, MaterialFrame } from '../../scene/material-dispatch';
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

it('retires view rows without Pass bins before their material version is released', () => {
  const f = fixture(0, 0),
    phase = new DirectDrawPhase();
  const held = new MaterialFrame(undefined).with(opaque);
  const input: DirectDrawInput = {
    ...f.input(),
    materials: held,
    entries: { selector: { LightMode: ['Deferred'] } },
    viewDraws: [source(91, opaque)],
    prepareUnbatched: (sources) =>
      sources.map((source, renderableIndex) => ({
        source,
        mesh,
        renderableIndex,
        meshSlot: 0,
        renderState: undefined,
        stencilReference: undefined,
      })),
  };
  const first = phase.sync(input);
  expect(first.rows).toHaveLength(1);
  expect(first.dispatch).toHaveLength(0);
  // The display owner withdraws its generated draw before its retained material lease.
  const retired = phase.sync({ ...input, viewDraws: [] });
  expect(retired.rows).toEqual([]);
  expect(retired).not.toBe(first);
  const released = phase.sync({ ...input, viewDraws: [], materials: held.without(opaque) });
  expect(released.rows).toEqual([]);
  expect(released.dispatch).toEqual([]);
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

it('observes mutable selection tokens and recovers after a partial iterator failure', () => {
  const f = fixture(2, 0);
  const phase = new DirectDrawPhase();
  const input = f.input();
  const tokens: unknown[] = [1];
  const select = vi.fn(input.select);
  const selected = { ...input, select, selection: tokens };
  phase.sync(selected);
  let evaluated = select.mock.calls.length;
  phase.sync(selected);
  expect(select.mock.calls.length).toBe(evaluated);
  tokens[0] = 2;
  phase.sync(selected);
  expect(select.mock.calls.length).toBeGreaterThan(evaluated);
  evaluated = select.mock.calls.length;
  tokens.push(undefined);
  phase.sync(selected);
  expect(select.mock.calls.length).toBeGreaterThan(evaluated);
  const failing = [3];
  failing[Symbol.iterator] = function* () {
    yield 3;
    throw new Error('selection interrupted');
  };
  expect(() => phase.sync({ ...input, selection: failing })).toThrow('selection interrupted');
  evaluated = select.mock.calls.length;
  const recovered = phase.sync(selected);
  expect(select.mock.calls.length).toBeGreaterThan(evaluated);
  expect(order(recovered)).toEqual(order(new DirectDrawPhase().sync(selected)));
  expect(phase.sync(selected)).toBe(recovered);
});

it.each([
  16, 1024,
])('retains distance order across camera motion without revisiting rows (N=%s)', (count) => {
  const f = fixture(0, count);
  const phase = new DirectDrawPhase();
  const first = phase.sync(f.input(eye(-100)));
  // Qualify the retained order once. Later positions stay in the same interval.
  expect(phase.sync(f.input(eye(-99)))).toBe(first);
  const work = { ...phase.work };
  for (const z of [-98, -95, -90]) {
    const input = f.input(eye(z));
    expect(phase.sync(input)).toBe(first);
    expect(phase.work.evaluated).toBe(work.evaluated);
    expect(phase.work).toEqual(work);
    expect(order(first)).toEqual(order(new DirectDrawPhase().sync(input)));
  }
  const reversed = f.input(eye(count + 100));
  const next = phase.sync(reversed);
  expect(order(next)).toEqual(order(new DirectDrawPhase().sync(reversed)));
  expect(next).not.toBe(first);
});

it('keeps one distance origin while rows change after camera-only reuse', () => {
  const f = fixture(0, 32);
  const phase = new DirectDrawPhase();
  phase.sync(f.input(eye(-100)));
  phase.sync(f.input(eye(-90)));
  for (const [entity, z] of [
    [4, -95],
    [18, -50],
    [10, -92],
  ] as const) {
    f.write([source(entity, glass, z)]);
    const input = f.input(eye(-90));
    expect(order(phase.sync(input))).toEqual(order(new DirectDrawPhase().sync(input)));
  }
});

it('matches fresh sorting across axis changes, ties and reused camera storage', () => {
  const f = fixture(0, 40);
  const sources = Array.from({ length: 40 }, (_, index) => {
    const row = source(index, glass, (index % 5) - 2);
    row.transform.world[12] = (index % 7) - 3;
    row.transform.world[13] = (index % 3) - 1;
    return row;
  });
  f.write(sources);
  const phase = new DirectDrawPhase();
  const camera = eye(0);
  for (const axis of [0, 1, 2, 0, 2]) {
    for (const value of [-20, -4, -1, 0, 1, 4, 20]) {
      camera.position[axis] = value;
      const input = f.input(camera);
      expect(order(phase.sync(input))).toEqual(order(new DirectDrawPhase().sync(input)));
    }
  }
});

it('does not evaluate every distance when a distance consumer has no camera', () => {
  const f = fixture(0, 32);
  const phase = new DirectDrawPhase();
  const input = f.input();
  assert(input.sort);
  const withoutCamera = { ...input, sort: { ...input.sort, camera: undefined } };
  phase.sync(withoutCamera);
  const work = { ...phase.work };
  phase.sync(withoutCamera);
  expect(phase.work).toEqual(work);
  phase.sync(f.input(eye(50)));
  expect(order(phase.sync(withoutCamera))).toEqual(
    order(new DirectDrawPhase().sync(withoutCamera)),
  );
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
  // Moving keeps every bin and Pass entry: no row is requeued, only re-sorted.
  expect(phase.work.retained - work.retained).toBe(8);
  expect(phase.binWork.dequeued - bins.dequeued).toBe(0);
  expect(phase.binWork.enqueued - bins.enqueued).toBe(0);
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

it('links temporal draw evidence across roster submissions (O(D) rows, exact output)', () => {
  const f = fixture(2_000, 0);
  f.scene.setTemporalTracking(true);
  const roster = () => f.scene.captureSubmission([], f.scene.slotsSnapshot());
  f.scene.commitSubmission(roster());
  const temporalInput = (): DirectDrawInput => {
    const input = f.input();
    const draws = input.scene.draws;
    assert(draws);
    return {
      ...input,
      scene: { ...input.scene, draws: { ...draws, temporal: f.scene.temporalDrawInputs() } },
    };
  };
  const phase = new DirectDrawPhase();
  phase.sync(temporalInput());
  const previousOf = (output: ReturnType<DirectDrawPhase['sync']>, entity: number) =>
    output.rows.find((row) => row.source.entityKey === entity)?.source.temporal?.previousTransform
      .world[14];
  for (let frame = 1; frame <= 3; frame++) {
    f.scene.commitSubmission(roster());
    // Two rows move each frame; a row that moved in the previous frame now
    // has a new submitted record and must be re-read too.
    f.write([source(10, opaque, 100 + frame), source(20 + frame, opaque, 200 + frame)]);
    const work = phase.work.rebuilt;
    const cold = phase.work.cold;
    const output = phase.sync(temporalInput());
    expect(phase.work.cold).toBe(cold);
    expect(phase.work.rebuilt - work).toBeLessThanOrEqual(4);
    const fresh = new DirectDrawPhase().sync(temporalInput());
    expect(order(output)).toEqual(order(fresh));
    for (const entity of [10, 20 + frame - 1, 20 + frame])
      expect(previousOf(output, entity)).toBe(previousOf(fresh, entity));
  }
  // The row moved two frames ago now reports its current pose as its previous one.
  f.scene.commitSubmission(roster());
  const settled = phase.sync(temporalInput());
  expect(previousOf(settled, 23)).toBe(203);
  expect(previousOf(settled, 10)).toBe(103);
  // A temporal cut cannot be linked: every row is re-read once.
  f.scene.setTemporalTracking(false);
  f.scene.setTemporalTracking(true);
  const cold = phase.work.cold;
  phase.sync(temporalInput());
  expect(phase.work.cold).toBe(cold + 1);
});

it('keeps placements of moved rows exactly equal to a fresh phase (randomized moves, material, layer and caster changes)', () => {
  const f = fixture(300, 40);
  const phase = new DirectDrawPhase();
  const camera = eye(-50);
  phase.sync(f.input(camera));
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const resources = [opaque, other, glass];
  const current = new Map<number, RenderableSnapshot>();
  for (let entity = 0; entity < 340; entity++)
    current.set(entity, source(entity, entity < 300 ? opaque : glass));
  const flatten = (output: ReturnType<DirectDrawPhase['sync']>) => ({
    rows: output.rows.map((row) => [
      row.source.entityKey,
      row.renderableIndex,
      row.source.transform.world[14],
      row.source.layer ?? 0,
      row.renderState?.blend === undefined,
    ]),
    dispatch: output.dispatch.map((entry, index) => [
      entry.entityIndex,
      entry.renderableIndex,
      entry.queue,
      entry.layer,
      entry.tags.LightMode,
      output.entryRows[index]?.source.transform.world[14],
    ]),
  });
  let retained = 0;
  for (let frame = 0; frame < 40; frame++) {
    const writes: RenderableSnapshot[] = [];
    for (let change = 0; change < 24; change++) {
      const entity = Math.floor(random() * 340);
      const before = current.get(entity) as RenderableSnapshot;
      const roll = random();
      const world = mat4.clone(before.transform.world);
      world[14] = (world[14] ?? 0) + (random() - 0.5) * 40;
      let next: RenderableSnapshot = { ...before, transform: { world } };
      if (roll < 0.1) {
        const resource = resources[Math.floor(random() * 3)] as MaterialResource;
        next = { ...next, material: resource, materials: [resource] };
      } else if (roll < 0.15) next = { ...next, layer: Math.floor(random() * 3) };
      else if (roll < 0.2) {
        // `shadowCaster` is either absent (casts) or `false`; toggle between the two.
        const { shadowCaster, ...casting } = next;
        next = shadowCaster === false ? casting : { ...next, shadowCaster: false };
      }
      current.set(entity, next);
      writes.push(next);
    }
    f.write(writes);
    const work = phase.work.retained;
    const input = f.input(camera);
    const output = phase.sync(input);
    retained += phase.work.retained - work;
    expect(flatten(output)).toEqual(flatten(new DirectDrawPhase().sync(input)));
  }
  // Most writes only move their row; those keep their bins and entries.
  expect(retained).toBeGreaterThan(400);
});
