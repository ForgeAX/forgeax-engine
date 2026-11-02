import { mat4, vec3 } from '@forgeax/engine-math';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
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
import { type DirectDrawInput, DirectDrawPhase, ViewDrawPhases } from '../direct-draw-phase';
import { MaterialRelations } from '../material-binding-index';
import { MemberMaterialPasses } from '../material-pass-groups';

/** Queue then emit: one recording-time sync of a retained phase. */
function drawn(phase: DirectDrawPhase, input: DirectDrawInput) {
  phase.queue(input);
  return phase.emit();
}

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

const order = (output: ReturnType<DirectDrawPhase['emit']>) =>
  output.dispatch.map((entry) => entry.entityIndex as number);

it('refreshes retained rows even when no authored pass enters a bin', () => {
  const f = fixture(1, 0);
  const phase = new DirectDrawPhase();
  const input = (): DirectDrawInput => ({
    ...f.input(),
    entries: { selector: { LightMode: ['Deferred'] } },
  });
  const first = drawn(phase, input());
  expect(first.dispatch).toHaveLength(0);
  expect(first.rows).toHaveLength(1);
  f.write([source(0, opaque, 9)]);
  const next = drawn(phase, input());
  expect(next.rows[0]?.source.transform.world[14]).toBe(9);
  expect(next).not.toBe(first);
  expect(drawn(phase, input())).toBe(next);
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
  const first = drawn(phase, input);
  expect(first.rows).toHaveLength(1);
  expect(first.dispatch).toHaveLength(0);
  // The display owner withdraws its generated draw before its retained material lease.
  const retired = drawn(phase, { ...input, viewDraws: [] });
  expect(retired.rows).toEqual([]);
  expect(retired).not.toBe(first);
  const released = drawn(phase, { ...input, viewDraws: [], materials: held.without(opaque) });
  expect(released.rows).toEqual([]);
  expect(released.dispatch).toEqual([]);
});

it('keeps a steady frame at zero phase work and returns the same output', () => {
  const f = fixture(2_000, 200);
  const phase = new DirectDrawPhase();
  const first = drawn(phase, f.input());
  expect(first.rows).toHaveLength(2_200);
  const work = { ...phase.work };
  const bins = { ...phase.binWork };
  const sort = { ...phase.sortWork };
  expect(drawn(phase, f.input())).toBe(first);
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
  drawn(phase, selected);
  let evaluated = select.mock.calls.length;
  drawn(phase, selected);
  expect(select.mock.calls.length).toBe(evaluated);
  tokens[0] = 2;
  drawn(phase, selected);
  expect(select.mock.calls.length).toBeGreaterThan(evaluated);
  evaluated = select.mock.calls.length;
  tokens.push(undefined);
  drawn(phase, selected);
  expect(select.mock.calls.length).toBeGreaterThan(evaluated);
  const failing = [3];
  failing[Symbol.iterator] = function* () {
    yield 3;
    throw new Error('selection interrupted');
  };
  expect(() => drawn(phase, { ...input, selection: failing })).toThrow('selection interrupted');
  evaluated = select.mock.calls.length;
  const recovered = drawn(phase, selected);
  expect(select.mock.calls.length).toBeGreaterThan(evaluated);
  expect(order(recovered)).toEqual(order(drawn(new DirectDrawPhase(), selected)));
  expect(drawn(phase, selected)).toBe(recovered);
});

it.each([
  16, 1024,
])('retains distance order across camera motion without revisiting rows (N=%s)', (count) => {
  const f = fixture(0, count);
  const phase = new DirectDrawPhase();
  const first = drawn(phase, f.input(eye(-100)));
  // Qualify the retained order once. Later positions stay in the same interval.
  expect(drawn(phase, f.input(eye(-99)))).toBe(first);
  const work = { ...phase.work };
  for (const z of [-98, -95, -90]) {
    const input = f.input(eye(z));
    expect(drawn(phase, input)).toBe(first);
    expect(phase.work.evaluated).toBe(work.evaluated);
    expect(phase.work).toEqual(work);
    expect(order(first)).toEqual(order(drawn(new DirectDrawPhase(), input)));
  }
  const reversed = f.input(eye(count + 100));
  const next = drawn(phase, reversed);
  expect(order(next)).toEqual(order(drawn(new DirectDrawPhase(), reversed)));
  expect(next).not.toBe(first);
});

it('keeps one distance origin while rows change after camera-only reuse', () => {
  const f = fixture(0, 32);
  const phase = new DirectDrawPhase();
  drawn(phase, f.input(eye(-100)));
  drawn(phase, f.input(eye(-90)));
  for (const [entity, z] of [
    [4, -95],
    [18, -50],
    [10, -92],
  ] as const) {
    f.write([source(entity, glass, z)]);
    const input = f.input(eye(-90));
    expect(order(drawn(phase, input))).toEqual(order(drawn(new DirectDrawPhase(), input)));
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
      expect(order(drawn(phase, input))).toEqual(order(drawn(new DirectDrawPhase(), input)));
    }
  }
});

it('does not evaluate every distance when a distance consumer has no camera', () => {
  const f = fixture(0, 32);
  const phase = new DirectDrawPhase();
  const input = f.input();
  assert(input.sort);
  const withoutCamera = { ...input, sort: { ...input.sort, camera: undefined } };
  drawn(phase, withoutCamera);
  const work = { ...phase.work };
  drawn(phase, withoutCamera);
  expect(phase.work).toEqual(work);
  drawn(phase, f.input(eye(50)));
  expect(order(drawn(phase, withoutCamera))).toEqual(
    order(drawn(new DirectDrawPhase(), withoutCamera)),
  );
});

it('updates only the D changed rows of a steady frame (O(D) bin and sort operations)', () => {
  const f = fixture(2_000, 200);
  const phase = new DirectDrawPhase();
  drawn(phase, f.input());
  const work = { ...phase.work };
  const bins = { ...phase.binWork };
  const sort = { ...phase.sortWork };
  // Four opaque and four blended rows move; the blended ones overtake the camera's far end.
  f.write([
    ...[3, 500, 1_200, 1_999].map((entity) => source(entity, opaque, entity + 0.5)),
    ...[2_000, 2_050, 2_100, 2_199].map((entity) => source(entity, glass, -10_000 - entity)),
  ]);
  const output = drawn(phase, f.input());
  expect(phase.work.rebuilt - work.rebuilt).toBe(8);
  // Moving keeps every bin and Pass entry: no row is requeued, only re-sorted.
  expect(phase.work.retained - work.retained).toBe(8);
  expect(phase.binWork.dequeued - bins.dequeued).toBe(0);
  expect(phase.binWork.enqueued - bins.enqueued).toBe(0);
  expect(phase.binWork.bins).toBe(bins.bins);
  expect(phase.sortWork.changed - sort.changed).toBe(8);
  expect(phase.work.cold).toBe(work.cold);
  // The retained order equals a fresh phase's order over the same frame.
  expect(order(output)).toEqual(order(drawn(new DirectDrawPhase(), f.input())));
  // DISTANCE draws back to front: the moved rows are now the farthest.
  expect(order(output).slice(2_000, 2_004)).toEqual([2_199, 2_100, 2_050, 2_000]);
});

it('dequeues a row from its old bin before it enqueues into the new one', () => {
  const f = fixture(100, 10);
  const phase = new DirectDrawPhase();
  drawn(phase, f.input());
  const bins = { ...phase.binWork };
  // One opaque row changes material (bin key); one blended row becomes opaque.
  f.write([source(7, other), source(105, opaque)]);
  const output = drawn(phase, f.input());
  expect(phase.binWork.dequeued - bins.dequeued).toBe(2);
  expect(phase.binWork.enqueued - bins.enqueued).toBe(2);
  expect(phase.binWork.bins - bins.bins).toBe(1);
  expect(output.dispatch.filter((entry) => entry.entityIndex === 7)).toHaveLength(1);
  expect(order(output)).toEqual(order(drawn(new DirectDrawPhase(), f.input())));
  expect(order(output).indexOf(105)).toBeLessThan(100);
});

it('keeps views independent: each view orders its own camera from its own diffs', () => {
  const f = fixture(0, 50);
  const near = new ViewDrawPhases();
  const far = new ViewDrawPhases();
  const front = near.of(f);
  const back = far.of(f);
  expect(near.of(f)).toBe(front);
  const a = drawn(front, f.input(eye(-100)));
  const b = drawn(back, f.input(eye(100)));
  expect(order(a)).toEqual([...order(b)].reverse());
  const before = { ...back.work };
  drawn(front, f.input(eye(-100)));
  expect(back.work).toEqual(before);
  // z=50 is the farthest row from z=-100 and the nearest from z=100.
  const work = { ...front.work };
  f.write([source(20, glass, 50)]);
  expect(order(drawn(front, f.input(eye(-100)))).at(0)).toBe(20);
  expect(order(drawn(back, f.input(eye(100)))).at(-1)).toBe(20);
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
  expect(drawn(phase, admitted()).rows).toHaveLength(1_000);
  const work = { ...phase.work };
  hidden = hidden.with(f.scene.slot(0, 10)?.slot ?? -1).with(f.scene.slot(0, 11)?.slot ?? -1);
  const output = drawn(phase, admitted());
  expect(phase.work.rebuilt - work.rebuilt).toBe(2);
  expect(output.rows).toHaveLength(998);
});

it('re-judges residency only for batches of the current plan', () => {
  const f = fixture(10, 0);
  const phase = new DirectDrawPhase();
  drawn(phase, f.input());
  // A new material binding retires the old batch; the resident table is rebuilt
  // without the retired binding in the same frame.
  for (let entity = 0; entity < 10; entity++) f.write([source(entity, other)]);
  const input = f.input();
  const live = new Map([...input.meshes].filter(([binding]) => binding.material === other));
  const output = drawn(phase, { ...input, meshes: live });
  expect(output.rows).toHaveLength(10);
  expect(order(output)).toEqual(order(drawn(new DirectDrawPhase(), { ...input, meshes: live })));
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
  const record = (output: ReturnType<DirectDrawPhase['emit']>) => (pass: RhiRenderPassEncoder) => {
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
      record(drawn(phase, f.input())),
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
  const first = drawn(phase, input());
  const rowOf = (output: ReturnType<DirectDrawPhase['emit']>) =>
    output.rows.find((row) => row.source.entityKey === 2);
  expect(rowOf(first)?.mesh).toBe(stream);
  expect(phase.derivesGeometry).toBe(true);
  const work = { ...phase.work };
  resolved.length = 0;
  // A steady sync rebuilds nothing but keeps the morph output alive.
  expect(drawn(phase, input())).toBe(first);
  expect(resolved).toEqual([2]);
  expect(phase.work.rebuilt).toBe(work.rebuilt);
  stream = { ...mesh } as MeshGpuHandles;
  expect(rowOf(drawn(phase, input()))?.mesh).toBe(stream);
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
  drawn(phase, temporalInput());
  const previousOf = (output: ReturnType<typeof drawn>, entity: number) =>
    output.rows.find((row) => row.source.entityKey === entity)?.source.temporal?.previousTransform
      .world[14];
  for (let frame = 1; frame <= 3; frame++) {
    f.scene.commitSubmission(roster());
    // Two rows move each frame; a row that moved in the previous frame now
    // has a new submitted record and must be re-read too.
    f.write([source(10, opaque, 100 + frame), source(20 + frame, opaque, 200 + frame)]);
    const work = phase.work.rebuilt;
    const cold = phase.work.cold;
    const output = drawn(phase, temporalInput());
    expect(phase.work.cold).toBe(cold);
    expect(phase.work.rebuilt - work).toBeLessThanOrEqual(4);
    const fresh = drawn(new DirectDrawPhase(), temporalInput());
    expect(order(output)).toEqual(order(fresh));
    for (const entity of [10, 20 + frame - 1, 20 + frame])
      expect(previousOf(output, entity)).toBe(previousOf(fresh, entity));
  }
  // The row moved two frames ago now reports its current pose as its previous one.
  f.scene.commitSubmission(roster());
  const settled = drawn(phase, temporalInput());
  expect(previousOf(settled, 23)).toBe(203);
  expect(previousOf(settled, 10)).toBe(103);
  // A temporal cut cannot be linked: every row is re-read once.
  f.scene.setTemporalTracking(false);
  f.scene.setTemporalTracking(true);
  const cold = phase.work.cold;
  drawn(phase, temporalInput());
  expect(phase.work.cold).toBe(cold + 1);
});

it('keeps placements of moved rows exactly equal to a fresh phase (randomized moves, material, layer and caster changes)', () => {
  const f = fixture(300, 40);
  const phase = new DirectDrawPhase();
  const camera = eye(-50);
  drawn(phase, f.input(camera));
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const resources = [opaque, other, glass];
  const current = new Map<number, RenderableSnapshot>();
  for (let entity = 0; entity < 340; entity++)
    current.set(entity, source(entity, entity < 300 ? opaque : glass));
  const flatten = (output: ReturnType<typeof drawn>) => ({
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
    const output = drawn(phase, input);
    retained += phase.work.retained - work;
    expect(flatten(output)).toEqual(flatten(drawn(new DirectDrawPhase(), input)));
  }
  // Most writes only move their row; those keep their bins and entries.
  expect(retained).toBeGreaterThan(400);
});
it('keeps Pass placements across parameter-only and unrelated material-frame changes', () => {
  const f = fixture(64, 0);
  const phase = new DirectDrawPhase();
  const raw = f.input();
  assert(raw.materials);
  const fixed = raw.materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
  });
  const input = {
    ...raw,
    materials: fixed,
    select: (binding: GpuDrivenBatchBinding) => fixed.get(binding.material)?.snapshot,
  };
  const first = drawn(phase, input);
  const materialFrame = input.materials;
  assert(materialFrame);
  const accepted = materialFrame.get(opaque);
  assert(accepted);
  const changed = materialFrame.with(opaque, undefined, {
    ...accepted.snapshot,
    baseColor: vec3.create(0.2, 0.4, 0.8),
  });
  expect(changed.get(opaque)?.passes).toBe(materialFrame.get(opaque)?.passes);
  const work = { ...phase.work };
  const bins = { ...phase.binWork };
  const next = drawn(phase, {
    ...input,
    materials: changed,
    select: (binding) => changed.get(binding.material)?.snapshot,
  });
  expect(phase.binWork.enqueued).toBe(bins.enqueued);
  expect(phase.binWork.dequeued).toBe(bins.dequeued);
  expect(phase.work.rebuilt).toBe(work.rebuilt);
  expect(next.dispatch).toBe(first.dispatch);
  expect(next.rows).toBe(first.rows);
  const unrelated = changed.with(other, 0, { ...other.snapshot, immutableValues: true });
  expect(
    drawn(phase, {
      ...input,
      materials: unrelated,
      select: (binding) => unrelated.get(binding.material)?.snapshot,
    }).dispatch,
  ).toBe(first.dispatch);
});

it('retains fixed dispatch identity for row-only moves while publishing new row snapshots', () => {
  const f = fixture(2048, 0);
  const phase = new DirectDrawPhase();
  const initial = f.input();
  assert(initial.materials);
  const materials = initial.materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
  });
  const input = () => ({
    ...f.input(),
    retainMaterialBindings: true,
    materials,
    select: (binding: GpuDrivenBatchBinding) => materials.get(binding.material)?.snapshot,
  });
  const first = drawn(phase, input());
  assert(first.materialRows);
  const oldRow = first.rows.find((row) => row.source.entityKey === 31);
  assert(oldRow);
  const oldZ = oldRow.source.transform.world[14];
  const append = vi.spyOn(MemberMaterialPasses.prototype, 'append');
  const finish = vi.spyOn(MemberMaterialPasses.prototype, 'finish');
  onTestFinished(() => {
    append.mockRestore();
    finish.mockRestore();
  });
  f.write([source(31, opaque, 200)]);
  const next = drawn(phase, input());
  expect(next.materialRows).toBe(first.materialRows);
  expect(append.mock.calls.length).toBe(0);
  expect(finish.mock.calls.length).toBe(0);
  expect(next.dispatch).toBe(first.dispatch);
  expect(next.rows.find((row) => row.source.entityKey === 31)?.source.transform.world[14]).toBe(
    200,
  );
  expect(oldRow.source.transform.world[14]).toBe(oldZ);
  expect(next.rows).not.toBe(first.rows);
  assert(first.materialPasses);
  assert(next.materialPasses);
  expect(next.materialPasses).toBe(first.materialPasses);
  expect(next.materialPasses.size).toBe(2048);
  for (const index of next.materialPasses.keys())
    expect(next.materialPasses.get(index)).toBe(first.materialPasses.get(index));
  expect(order(next)).toEqual(order(drawn(new DirectDrawPhase(), input())));
});

it('keeps borrowed material tables on the ordinary dispatch replacement path', () => {
  const f = fixture(16, 0);
  const phase = new DirectDrawPhase();
  expect(f.input().materials?.hasBorrowedValues).toBe(true);
  const first = drawn(phase, f.input());
  f.write([source(3, opaque, 20)]);
  const next = drawn(phase, f.input());
  expect(first.materialPasses).toBeUndefined();
  expect(next.materialPasses).toBeUndefined();
  expect(next.dispatch).not.toBe(first.dispatch);
  expect(order(next)).toEqual(order(drawn(new DirectDrawPhase(), f.input())));
});

it('replaces the consumed dispatch key when compact indices move to a new offset', () => {
  const f = fixture(4, 0);
  const raw = f.input();
  assert(raw.materials);
  const materials = raw.materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
  });
  const phase = new DirectDrawPhase();
  phase.queue({
    ...raw,
    materials,
    select: (binding) => materials.get(binding.material)?.snapshot,
  });
  const first = phase.emit(0);
  const shifted = phase.emit(100);
  expect(shifted.dispatch).not.toBe(first.dispatch);
  expect(shifted.dispatch.map((entry) => entry.renderableIndex)).toEqual([100, 101, 102, 103]);
  assert(first.materialPasses);
  assert(shifted.materialPasses);
  expect(shifted.materialPasses).not.toBe(first.materialPasses);
  expect([...shifted.materialPasses.keys()]).toEqual([100, 101, 102, 103]);
  for (let index = 0; index < 4; index++)
    expect(shifted.materialPasses.get(index + 100)).toBe(first.materialPasses.get(index));
});

it('reprojects a changed temporal mode even when the emitted dispatch is retained', () => {
  const f = fixture(1, 0);
  const raw = f.input();
  assert(raw.materials);
  const forward = opaque.snapshot.passes[0];
  assert(forward);
  const materials = raw.materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
    passes: [
      forward,
      { ...forward, name: 'Deferred', renderState: { tags: { LightMode: 'Deferred' } } },
    ],
  });
  const input = {
    ...raw,
    materials,
    select: (binding: GpuDrivenBatchBinding) => materials.get(binding.material)?.snapshot,
  };
  const phase = new DirectDrawPhase();
  const color = drawn(phase, input);
  const temporal = drawn(phase, { ...input, entries: { selector: undefined, temporal: true } });
  expect(temporal.dispatch).toBe(color.dispatch);
  expect(color.materialPasses?.temporal).toBe(false);
  expect(temporal.materialPasses?.temporal).toBe(true);
  expect(temporal.materialPasses).not.toBe(color.materialPasses);
  expect(color.materialPasses?.get(0)?.get(1)).toHaveLength(2);
  expect(temporal.materialPasses?.get(0)?.get(1)).toBe(color.dispatch[0]);
});

it('rebuilds only the changed members material groups in a mixed phase', () => {
  const f = fixture(2048, 0);
  const phase = new DirectDrawPhase();
  const input = (): DirectDrawInput => {
    const raw = f.input();
    assert(raw.materials);
    let materials = raw.materials;
    for (const resource of [opaque, other])
      materials = materials.with(resource, undefined, {
        ...resource.snapshot,
        immutableValues: true,
      });
    return {
      ...raw,
      materials,
      select: (binding) => materials.get(binding.material)?.snapshot,
    };
  };
  const first = drawn(phase, input());
  const originalPasses = first.materialPasses;
  assert(originalPasses);
  const original = new Map(
    first.rows.map((row) => [row.source.entityKey, originalPasses.get(row.renderableIndex)]),
  );
  f.write([source(31, other, 200)]);
  const next = drawn(phase, input());
  const nextPasses = next.materialPasses;
  assert(nextPasses);
  let replaced = 0;
  for (const row of next.rows) {
    const passes = nextPasses.get(row.renderableIndex);
    if (passes !== original.get(row.source.entityKey)) replaced += 1;
    expect(passes?.get(row.source.entityKey === 31 ? 2 : 1)).toBeDefined();
  }
  expect(replaced).toBe(1);
  expect(order(next)).toEqual(order(drawn(new DirectDrawPhase(), input())));
});

it('releases retired material groups while their phase member remains live', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const f = fixture(1, 0);
  const raw = f.input();
  assert(raw.materials);
  const materials = raw.materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
  });
  const phase = new DirectDrawPhase();
  const retired = (() => {
    const output = drawn(phase, {
      ...raw,
      materials,
      select: (binding) => materials.get(binding.material)?.snapshot,
    });
    const groups = output.materialPasses?.get(0);
    assert(groups);
    return new WeakRef(groups);
  })();
  const changed = materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
    passes: [],
  });
  const output = drawn(phase, {
    ...raw,
    materials: changed,
    select: (binding) => changed.get(binding.material)?.snapshot,
  });
  expect(output.rows).toHaveLength(1);
  expect(output.dispatch).toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  expect(retired.deref()).toBeUndefined();
});

it('keeps per-source morph preparation on a fixed parameter change while rigid rows retain work', () => {
  const f = fixture(16, 0);
  f.write([{ ...source(3, opaque), morph: { weights: new Float32Array([1]), targetCount: 1 } }]);
  const raw = f.input();
  assert(raw.materials);
  const materials = raw.materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
  });
  const phase = new DirectDrawPhase();
  const input = {
    ...raw,
    materials,
    select: (binding: GpuDrivenBatchBinding) => materials.get(binding.material)?.snapshot,
  };
  drawn(phase, input);
  const work = { ...phase.work };
  const accepted = materials.get(opaque);
  assert(accepted);
  const changed = materials.with(opaque, undefined, { ...accepted.snapshot, roughness: 0.2 });
  drawn(phase, {
    ...input,
    materials: changed,
    select: (binding) => changed.get(binding.material)?.snapshot,
  });
  expect(phase.work.rebuilt - work.rebuilt).toBe(1);
});

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

it('maintains material relations only while their recording owner admits reuse', () => {
  const f = fixture(64, 0);
  const phase = new DirectDrawPhase();
  const raw = f.input();
  assert(raw.materials);
  const materials = raw.materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
  });
  const input = {
    ...raw,
    materials,
    select: (binding: GpuDrivenBatchBinding) => materials.get(binding.material)?.snapshot,
  };
  expect(drawn(phase, input).materialRows).toBeUndefined();
  const retained = drawn(phase, { ...input, retainMaterialBindings: true });
  assert(retained.materialRows);
  const first = retained.materialRows.at(0);
  expect(drawn(phase, { ...input, retainMaterialBindings: false }).materialRows).toBeUndefined();
  expect(retained.materialRows.at(0)).toBe(first);
  expect(drawn(phase, { ...raw, retainMaterialBindings: true }).materialRows).toBeUndefined();
});

it('retries an emitted material relationship failure instead of accepting the prior output', () => {
  const f = fixture(64, 0);
  const phase = new DirectDrawPhase();
  const raw = f.input();
  assert(raw.materials);
  const materials = raw.materials.with(opaque, undefined, {
    ...opaque.snapshot,
    immutableValues: true,
  });
  phase.queue({
    ...raw,
    materials,
    retainMaterialBindings: true,
    select: (binding) => materials.get(binding.material)?.snapshot,
  });
  const write = vi.spyOn(MaterialRelations.prototype, 'write');
  onTestFinished(() => write.mockRestore());
  write.mockImplementationOnce(() => {
    throw new Error('relation-write-failed');
  });
  expect(() => phase.emit()).toThrow('relation-write-failed');
  const retried = phase.emit();
  expect(retried.rows).toHaveLength(64);
  expect(retried.materialRows?.length).toBe(64);
});
