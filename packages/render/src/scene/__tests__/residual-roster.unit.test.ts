import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { BatchSources } from '../../gpu-driven/batch-members';
import { BatchTopology } from '../../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../../gpu-driven/draw-selection';
import { MaterialResource } from '../../material-resource';
import { makeZeroCameraFallbackSnapshot } from '../../record/frame-snapshot';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { FrameSet } from '../frame-set';
import { MaterialDispatch } from '../material-dispatch';
import { MeshFrame } from '../mesh-frame';
import { RenderScene } from '../render-scene';
import { ResidualRoster } from '../residual-roster';
import { ViewCull, type ViewCullInput } from '../view-cull';

const covered = new MaterialResource(defaultMaterialSnapshot(1));
// A distinct texture binding keeps the residual material out of the covered row-material batch.
const residual = new MaterialResource({
  ...defaultMaterialSnapshot(2),
  textureHandles: new Map([['baseColorTexture', 2]]),
} as unknown as ReturnType<typeof defaultMaterialSnapshot>);

function source(entityKey: number, material: MaterialResource, batched = true): RenderableSnapshot {
  const base = receiptRow().source;
  return {
    ...base,
    entityKey,
    material,
    materials: [material],
    gpuDrivenDraws: batched ? (base.gpuDrivenDraws?.slice(0, 1) ?? []) : [],
  };
}

function fixture(count: number, primary = covered, secondary = residual) {
  const scene = new RenderScene();
  const topology = new BatchTopology();
  const write = (sources: readonly RenderableSnapshot[]) =>
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
  write([
    ...Array.from({ length: count }, (_, index) => source(index, primary)),
    ...Array.from({ length: 8 }, (_, index) => source(count + index, secondary)),
  ]);
  const select = (material: MaterialResource) =>
    GpuDrawSelection.fixed(
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.filter((batch) => batch.binding?.material === material),
    );
  const roster = new ResidualRoster();
  const sync = (selection: GpuDrawSelection) =>
    roster.sync(topology.sourcePlan(), topology.unbatchedSlots, selection);
  const entities = () =>
    [...roster.slots].map((slot) => scene.slotsSnapshot().slotAt(slot)?.entityKey);
  return { scene, topology, write, select, roster, sync, entities };
}

it('keeps the residual set from diffs: steady syncs and covered members cost nothing', () => {
  const f = fixture(10_000);
  const selection = f.select(covered);
  f.sync(selection);
  expect(f.entities()).toEqual([10_000, 10_001, 10_002, 10_003, 10_004, 10_005, 10_006, 10_007]);
  const before = { ...f.roster.work };
  f.sync(selection);
  f.sync(f.select(covered));
  expect(f.roster.work).toEqual(before);

  // One residual and one covered row change: one member each way at most, no batch walk.
  f.write([source(10_008, residual), source(10_009, covered)]);
  f.sync(f.select(covered));
  expect(f.roster.work.members - before.members).toBe(1);
  expect(f.roster.work.cold).toBe(before.cold);
  expect(f.entities()).toContain(10_008);
  expect(f.entities()).not.toContain(10_009);

  // Unbatched geometry enters and leaves through the topology's fixed set.
  f.write([source(20_000, residual, false)]);
  f.sync(f.select(covered));
  expect(f.entities()).toContain(20_000);
  f.topology.apply(f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 20_000 }]));
  f.sync(f.select(covered));
  expect(f.entities()).not.toContain(20_000);
});

it('moves only the flipped batch when the GPU selection changes coverage', () => {
  const f = fixture(1_000);
  f.sync(f.select(covered));
  const before = { ...f.roster.work };
  // Covering the residual binding instead moves 8 + 1000 members, one batch each way.
  f.sync(f.select(residual));
  expect(f.roster.work.batches - before.batches).toBe(2);
  expect(f.roster.work.members - before.members).toBe(1_008);
  expect(f.entities()).toHaveLength(1_000);
  expect(f.entities()).not.toContain(1_000);
});

it('rechecks only the changed coverage route among many unrelated source batches', () => {
  const f = fixture(1);
  f.write(
    Array.from({ length: 1024 }, (_, index) => ({
      ...source(100 + index, covered),
      assetHandle: 100 + index,
    })),
  );
  const plan = f.topology.sourcePlan();
  const batches = Array.from(plan.sourceGroups ?? plan.batches);
  f.sync(GpuDrawSelection.fixed(batches));
  const removed = batches.at(-1);
  if (removed === undefined) throw Error('missing batch');
  const selection = GpuDrawSelection.fixed(batches.slice(0, -1));
  const covers = vi.spyOn(selection, 'coversBinding');
  const before = { ...f.roster.work };
  const held = f.roster.slots;
  f.sync(selection);
  expect(covers).toHaveBeenCalledTimes(1);
  expect(f.roster.work.batchVisits - before.batchVisits).toBe(1);
  expect(f.roster.slots.size).toBe(removed.candidates.length);
  expect(held.size).toBe(0);
});

it('rechecks peer bindings whose coverage follows the changed execution', () => {
  const f = fixture(1);
  const seed = f.topology.sourcePlan().batches.at(0);
  if (seed?.binding === undefined) throw Error('missing binding');
  let sources = new BatchSources().with(seed);
  sources = sources.with({ ...seed, batchId: seed.batchId + 100, binding: { ...seed.binding } });
  const plan = { ...f.topology.sourcePlan(), sourceGroups: sources, batches: sources };
  const one = GpuDrawSelection.fixed([sources.at(0) ?? seed]);
  f.roster.sync(plan, new FrameSet(), one);
  expect(f.roster.slots.size).toBe(0);
  const before = f.roster.work.batchVisits;
  f.roster.sync(plan, new FrameSet(), GpuDrawSelection.fixed([]));
  expect(f.roster.work.batchVisits - before).toBe(2);
  expect(f.roster.slots.size).toBe(seed.candidates.length);
  // Removing a peer while restoring the remaining execution drops both references.
  sources = sources.without(seed.batchId + 100);
  f.roster.sync({ ...plan, sourceGroups: sources, batches: sources }, new FrameSet(), one);
  expect(f.roster.slots.size).toBe(0);
});

function cullFixture(count: number, primary = covered, secondary = residual) {
  const f = fixture(count, primary, secondary);
  const dispatch = new MaterialDispatch();
  for (const row of f.scene.slotsSnapshot()) dispatch.bind(row.slot, row.snapshot);
  const view = new ViewCull();
  const input: ViewCullInput = {
    shared: {
      topology: f.topology,
      materialDispatch: dispatch,
      unavailableSlots: new FrameSet(),
    } as ViewCullInput['shared'],
    projection: f.scene,
    frame: {
      cameras: [],
      renderables: f.scene.materialize(),
      lights: [],
    } as unknown as ViewCullInput['frame'],
    materials: dispatch.materials(),
    meshes: f.scene.meshFrame(),
    skin: undefined,
    hasGeneratedDraws: false,
    gpuSelection: new GpuDrawSelection([]),
    plan: () => f.topology.sourcePlan(),
    slotDraws: () => f.scene.drawFrame(dispatch.materials()),
  };
  const current = (extra: Partial<ViewCullInput> = {}) => ({
    ...input,
    frame: { ...input.frame, renderables: f.scene.materialize() },
    ...extra,
  });
  return { ...f, dispatch, view, input, current };
}

function enclosingCamera(x: number) {
  const base = makeZeroCameraFallbackSnapshot();
  const world = new Float32Array(base.world);
  world[12] = x;
  world[14] = 12;
  return {
    ...base,
    projection: 'orthographic' as const,
    position: vec3.create(x, 0, 12),
    world,
    orthoLeft: -10,
    orthoRight: 10,
    orthoBottom: -10,
    orthoTop: 10,
  };
}

it.each([
  16, 4096,
])('proves camera motion over unchanged residual bounds without visiting N=%s rows', (count) => {
  const material = new MaterialResource({ ...defaultMaterialSnapshot(77), immutableValues: true });
  const f = cullFixture(count, material, material);
  const current = (x: number) => {
    const input = f.current();
    return { ...input, frame: { ...input.frame, cameras: [enclosingCamera(x)] } };
  };
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    const old = f.view.cull(current(0));
    expect(bounds).toHaveBeenCalledTimes(count + 8);
    expect(old.frame.cameraAdmission?.hidden.size).toBe(0);
    bounds.mockClear();
    const moved = f.view.cull(current(0.1));
    expect(bounds).not.toHaveBeenCalled();
    expect(moved.frame.cameraAdmission?.hidden.size).toBe(0);
    const source = f.scene.slotAt(1)?.snapshot;
    if (source === undefined) throw new Error('Missing residual row');
    const world = new Float32Array(source.transform.world);
    world[12] = 0.2;
    f.write([{ ...source, transform: { world } }]);
    f.view.cull(current(0.2));
    expect(bounds).toHaveBeenCalledTimes(1);
    bounds.mockClear();
    const outside = f.view.cull(current(100));
    expect(bounds).toHaveBeenCalledTimes(count + 8);
    expect(outside.frame.cameraAdmission?.hidden.size).toBe(count + 8);
    bounds.mockClear();
    const returned = f.view.cull(current(0.3));
    expect(bounds).not.toHaveBeenCalled();
    expect(returned.frame.cameraAdmission?.hidden.size).toBe(0);
    expect(outside.frame.cameraAdmission?.hidden.size).toBe(count + 8);
  } finally {
    bounds.mockRestore();
  }
});

it('invalidates residual bounds for consumed Mesh versions and ignores unrelated Mesh replacements', () => {
  const material = new MaterialResource({ ...defaultMaterialSnapshot(78), immutableValues: true });
  const f = cullFixture(16, material, material);
  const mesh = createPrimitiveMesh('cube').unwrap();
  let meshes = new MeshFrame().with(0, 9, mesh);
  f.view.cull(f.current({ meshes }));
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    meshes = meshes.with(0, 99, mesh);
    f.view.cull(f.current({ meshes }));
    expect(bounds).not.toHaveBeenCalled();
    meshes = meshes.with(0, 9, mesh);
    f.view.cull(f.current({ meshes }));
    expect(bounds).toHaveBeenCalledTimes(24);
    bounds.mockClear();
    meshes = meshes.without(0, 9);
    f.view.cull(f.current({ meshes }));
    expect(bounds).toHaveBeenCalledTimes(24);
    bounds.mockClear();
    meshes = meshes.with(0, 9, mesh);
    f.view.cull(f.current({ meshes }));
    expect(bounds).toHaveBeenCalledTimes(24);
  } finally {
    bounds.mockRestore();
  }
});

it('tests an edited outside row even when the prior residual envelope is enclosed', () => {
  const material = new MaterialResource({ ...defaultMaterialSnapshot(79), immutableValues: true });
  const f = cullFixture(16, material, material);
  const current = (x: number) => {
    const input = f.current();
    return { ...input, frame: { ...input.frame, cameras: [enclosingCamera(x)] } };
  };
  const old = f.view.cull(current(0));
  const source = f.scene.slotAt(1)?.snapshot;
  if (source === undefined) throw new Error('Missing edited row');
  const world = new Float32Array(source.transform.world);
  world[12] = 100;
  f.write([{ ...source, transform: { world } }]);
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    const edited = f.view.cull(current(0.1));
    expect(bounds).toHaveBeenCalledTimes(1);
    expect(edited.frame.cameraAdmission?.hidden.size).toBe(1);
    expect(old.frame.cameraVisible?.(source)).toBe(true);
    expect(edited.frame.cameraVisible?.(source)).toBe(false);
    bounds.mockClear();
    // The expanded envelope no longer proves containment for the next camera.
    const moved = f.view.cull(current(0.2));
    expect(bounds).toHaveBeenCalledTimes(24);
    expect(moved.frame.cameraAdmission?.hidden.size).toBe(1);
  } finally {
    bounds.mockRestore();
  }
});

it('retains complete tests for borrowed material values across camera and Mesh changes', () => {
  const f = cullFixture(16);
  const mesh = createPrimitiveMesh('cube').unwrap();
  const meshes = new MeshFrame().with(0, 9, mesh);
  const current = (x: number, geometry = meshes) => {
    const input = f.current({ meshes: geometry });
    return { ...input, frame: { ...input.frame, cameras: [enclosingCamera(x)] } };
  };
  expect(f.input.materials.hasBorrowedValues).toBe(true);
  f.view.cull(current(0));
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    f.view.cull(current(0.1));
    expect(bounds).toHaveBeenCalledTimes(24);
    bounds.mockClear();
    f.view.cull(current(0.1, meshes.with(0, 99, mesh)));
    expect(bounds).toHaveBeenCalledTimes(24);
  } finally {
    bounds.mockRestore();
  }
});

it('does not re-test unchanged residual bounds and publishes the current frame facts', () => {
  const f = fixture(1000);
  const dispatch = new MaterialDispatch();
  for (const row of f.scene.slotsSnapshot()) dispatch.bind(row.slot, row.snapshot);
  const view = new ViewCull();
  const selection = new GpuDrawSelection([]);
  const input: ViewCullInput = {
    shared: {
      topology: f.topology,
      materialDispatch: dispatch,
      unavailableSlots: new FrameSet(),
    } as ViewCullInput['shared'],
    projection: f.scene,
    frame: {
      cameras: [],
      renderables: f.scene.materialize(),
      lights: [],
    } as unknown as ViewCullInput['frame'],
    materials: dispatch.materials(),
    meshes: f.scene.meshFrame(),
    skin: undefined,
    hasGeneratedDraws: false,
    gpuSelection: selection,
    plan: () => f.topology.sourcePlan(),
    slotDraws: () => f.scene.drawFrame(dispatch.materials()),
  };
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    view.cull(input);
    expect(bounds).toHaveBeenCalledTimes(1008);
    bounds.mockClear();
    const fresh = { ...input.frame, cameras: [], lights: [] } as unknown as ViewCullInput['frame'];
    const quiet = view.cull({ ...input, frame: fresh });
    expect(bounds).not.toHaveBeenCalled();
    expect(quiet.frame.lights).toBe(fresh.lights);
    expect(quiet.frame.cameras).toBe(fresh.cameras);
    const invalidations: ViewCullInput[] = [
      { ...input, meshes: new MeshFrame() },
      {
        ...input,
        materials: input.materials.with(new MaterialResource(defaultMaterialSnapshot(99))),
      },
      { ...input, frame: { ...input.frame, cameras: [makeZeroCameraFallbackSnapshot()] } },
    ];
    for (const changed of invalidations) {
      view.cull(input);
      bounds.mockClear();
      view.cull(changed);
      expect(bounds.mock.calls.length).toBeGreaterThan(0);
    }
    const prior = f.scene.slotAt(1000)?.snapshot;
    if (prior === undefined) throw new Error('Missing residual row');
    f.write([{ ...prior, transform: { world: new Float32Array(prior.transform.world) } }]);
    bounds.mockClear();
    view.cull({ ...input, frame: { ...input.frame, renderables: f.scene.materialize() } });
    expect(bounds.mock.calls.length).toBeGreaterThan(0);
  } finally {
    bounds.mockRestore();
  }
});

it.each([
  16, 4096,
])('tests one changed residual bound regardless of roster size (N=%s)', (count) => {
  const f = cullFixture(count);
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    const old = f.view.cull(f.current());
    expect(bounds).toHaveBeenCalledTimes(count + 8);
    const row = f.scene.slotAt(1)?.snapshot;
    if (row === undefined) throw new Error('Missing test row');
    const world = new Float32Array(row.transform.world);
    world[12] = 100;
    f.write([{ ...row, transform: { world } }]);
    bounds.mockClear();
    const next = f.view.cull(f.current());
    expect(bounds).toHaveBeenCalledTimes(1);
    expect(next.frame.cameraAdmission?.residual.size).toBe(count + 8);
    expect(old.frame.cameraAdmission?.hidden.size).toBe(0);
    expect(old.frame.cameraVisible?.(row)).toBe(true);
    bounds.mockClear();
    f.view.cull(f.current());
    expect(bounds).not.toHaveBeenCalled();
  } finally {
    bounds.mockRestore();
  }
});

it('does not test residual rows for a covered-row edit, and tests availability diffs only', () => {
  const f = cullFixture(1024);
  const selection = f.select(covered);
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    f.view.cull(f.current({ gpuSelection: selection }));
    expect(bounds).toHaveBeenCalledTimes(8);
    f.write([source(0, covered)]);
    bounds.mockClear();
    f.view.cull(f.current({ gpuSelection: f.select(covered) }));
    expect(bounds).not.toHaveBeenCalled();
    const shared = { ...f.input.shared, unavailableSlots: new FrameSet().with(1024) };
    bounds.mockClear();
    f.view.cull(f.current({ gpuSelection: f.select(covered), shared }));
    expect(bounds).not.toHaveBeenCalled();
    f.view.cull(f.current({ gpuSelection: f.select(covered) }));
    expect(bounds).toHaveBeenCalledTimes(1);
  } finally {
    bounds.mockRestore();
  }
});

it('removes and reuses residual slots without retaining the removed row visibility', () => {
  const f = cullFixture(16);
  const camera = { ...makeZeroCameraFallbackSnapshot(), projection: 'orthographic' as const };
  const frame = () => ({ ...f.current(), frame: { ...f.current().frame, cameras: [camera] } });
  const row = f.scene.slotAt(1)?.snapshot;
  if (row === undefined) throw new Error('Missing test row');
  const world = new Float32Array(row.transform.world);
  world[12] = 100;
  f.write([{ ...row, transform: { world } }]);
  const old = f.view.cull(frame());
  const hidden = f.scene.slotAt(1)?.snapshot;
  if (hidden === undefined) throw new Error('Missing hidden row');
  expect(old.frame.cameraVisible?.(hidden)).toBe(false);
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    f.topology.apply(f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]));
    const removed = f.view.cull(frame());
    expect(bounds).not.toHaveBeenCalled();
    expect(removed.frame.cameraAdmission?.hidden.size).toBe(0);
    f.write([source(100, covered)]);
    const next = f.view.cull(frame());
    expect(bounds).toHaveBeenCalledTimes(1);
    expect(next.frame.cameraVisible?.(source(100, covered))).toBe(true);
    expect(old.frame.cameraVisible?.(hidden)).toBe(false);
    expect(old.frame.cameraAdmission?.hidden.size).toBe(1);
  } finally {
    bounds.mockRestore();
  }
});

it('falls back to a complete residual test when the row journal cannot prove its delta', () => {
  const f = cullFixture(16);
  f.view.cull(f.current());
  const journal = f.scene.slotsSnapshot().journal;
  if (journal === undefined) throw new Error('Missing owned row journal');
  journal.reset();
  f.write([source(0, covered)]);
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    f.view.cull(f.current());
    expect(bounds).toHaveBeenCalledTimes(24);
  } finally {
    bounds.mockRestore();
  }
});

it('keeps residual bounds across numeric material edits and invalidates displacement or position proof', () => {
  const material = new MaterialResource({ ...defaultMaterialSnapshot(31), immutableValues: true });
  const f = cullFixture(16, material, material);
  f.view.cull(f.current());
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  const change = (extra: Partial<typeof material.snapshot>) => {
    material.adopt({ ...material.snapshot, ...extra });
    f.dispatch.adopt(material);
    return f.view.cull(f.current({ materials: f.dispatch.materials() }));
  };
  try {
    change({ paramSnapshot: { baseColor: [0.5, 0.5, 0.5, 1] } });
    expect(bounds).not.toHaveBeenCalled();
    change({
      materialParamSchema: [{ name: 'displacementTexture', type: 'texture2d' }],
      paramSnapshot: { displacementScale: 2 },
    });
    expect(bounds).toHaveBeenCalledTimes(24);
    bounds.mockClear();
    change({ positionBounds: undefined });
    expect(bounds).toHaveBeenCalledTimes(24);
    bounds.mockClear();
    const { immutableValues: _ownership, ...borrowed } = material.snapshot;
    material.adopt(borrowed);
    f.dispatch.adopt(material);
    f.view.cull(f.current({ materials: f.dispatch.materials() }));
    expect(bounds).toHaveBeenCalledTimes(24);
    bounds.mockClear();
    change({ paramSnapshot: { displacementScale: 2, baseColor: [1, 0, 0, 1] } });
    expect(bounds).toHaveBeenCalledTimes(24);
  } finally {
    bounds.mockRestore();
  }
});

it('ignores changing Skin inputs when no residual row has a Skin binding', () => {
  const f = cullFixture(16);
  const skin = (root: object) =>
    ({
      slots: f.scene.slotsSnapshot(),
      current: { inputRoot: () => root, readable: true },
      previous: undefined,
    }) as unknown as NonNullable<ViewCullInput['skin']>;
  f.view.cull(f.current({ skin: skin({}) }));
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt');
  try {
    f.view.cull(f.current({ skin: skin({}) }));
    expect(bounds).not.toHaveBeenCalled();
  } finally {
    bounds.mockRestore();
  }
});

it('re-tests residual Skin rows alone when their input root changes', () => {
  const f = cullFixture(16);
  const base = f.scene.slotAt(1)?.snapshot;
  if (base === undefined) throw new Error('Missing test row');
  f.write([{ ...base, skinBinding: { skeleton: 7, joints: [19] } }]);
  const skin = (root: object) =>
    ({
      slots: f.scene.slotsSnapshot(),
      current: { inputRoot: () => root, readable: true },
      previous: undefined,
    }) as unknown as NonNullable<ViewCullInput['skin']>;
  // Isolate cull invalidation from palette/geometry resolution in this unit test.
  const bounds = vi.spyOn(f.scene, 'writeCullingWorldBoundsAt').mockReturnValue(false);
  try {
    f.view.cull(f.current({ skin: skin({}) }));
    expect(bounds).toHaveBeenCalledTimes(24);
    bounds.mockClear();
    f.view.cull(f.current({ skin: skin({}) }));
    expect(bounds).toHaveBeenCalledTimes(1);
    expect(bounds.mock.calls[0]?.[0].snapshot.skinBinding).toBeDefined();
  } finally {
    bounds.mockRestore();
  }
});

it('matches a cold camera cull through row, availability, coverage and camera changes', () => {
  const f = cullFixture(16);
  let state = 97;
  for (let step = 0; step < 120; step++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const entity = state % 16;
    if (step % 11 === 0)
      f.topology.apply(f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: entity }]));
    else {
      const base = source(entity, covered);
      const { localAabb, ...withoutBounds } = base;
      const world = new Float32Array(base.transform.world);
      world[12] = (state >>> 8) % 20;
      world[14] = -5;
      f.write([
        {
          ...withoutBounds,
          transform: { world },
          authorVisible: step % 7 !== 0,
          ...(step % 5 === 0 || localAabb === undefined ? {} : { localAabb }),
        },
      ]);
    }
    const input = f.current({
      gpuSelection: step % 3 === 0 ? f.select(covered) : f.input.gpuSelection,
      shared: {
        ...f.input.shared,
        unavailableSlots: new FrameSet().with(step % 24),
      },
    });
    input.frame = {
      ...input.frame,
      cameras: step % 13 === 0 ? [] : [makeZeroCameraFallbackSnapshot()],
    };
    const incremental = f.view.cull(input).frame;
    const cold = new ViewCull().cull(input).frame;
    for (const row of input.frame.renderables)
      expect(incremental.cameraVisible?.(row)).toBe(cold.cameraVisible?.(row));
    expect([...(incremental.cameraAdmission?.hidden ?? [])]).toEqual([
      ...(cold.cameraAdmission?.hidden ?? []),
    ]);
    expect(incremental.frustumStats).toEqual(cold.frustumStats);
  }
});

it.each([
  16, 4096,
])('resolves only sparse CPU Skin rows among N=%i residual rows and retains frame availability', (count) => {
  const f = cullFixture(count);
  const skin = {
    ...source(count + 8, residual, false),
    skinBinding: { skeleton: 7, joints: [19] },
  };
  f.write([skin]);
  let resolved = 0;
  const input = f.current({
    slotDraws: () => {
      const draw = f.scene.drawFrame(f.input.materials);
      return (slot) => {
        resolved++;
        return draw(slot);
      };
    },
  });
  const old = f.view.cull(input).frame.gpuOwned;
  if (old?.residualSkin === undefined) throw new Error('Missing producer-owned sparse Skin query');
  expect([...old.residualSkin()].map((row) => row.entityKey)).toEqual([skin.entityKey]);
  expect(resolved).toBe(1);
  const slot = f.scene.slotsSnapshot().identitySlot(0, skin.entityKey);
  if (slot === undefined) throw new Error('Missing Skin slot');
  input.shared.unavailableSlots = input.shared.unavailableSlots.with(slot);
  const current = f.view.cull(input).frame.gpuOwned;
  expect([...(current?.residualSkin?.() ?? [])]).toEqual([]);
  // Resolve the old query again after its shared composition changed availability.
  expect([...old.residualSkin()].map((row) => row.entityKey)).toEqual([skin.entityKey]);
});

it('keeps residual read membership persistent and resolves only rows a consumer reads', () => {
  const f = cullFixture(1000);
  const fixed = f.scene.drawFrame(f.dispatch.materials());
  const read = vi.fn(fixed);
  const input = f.current({ slotDraws: () => read });
  f.view.cull(input);
  const warm = f.view.cull(input).frame.gpuOwned;
  if (warm === undefined || input.gpuSelection === undefined) throw new Error('missing GPU frame');
  read.mockClear();
  const held = warm.residual(input.gpuSelection);
  expect(read).not.toHaveBeenCalled();
  const records = warm.residualSlots(input.gpuSelection);
  expect(held.length).toBe(records.length);
  expect(read).not.toHaveBeenCalled();
  expect(held.at(0)?.entityKey).toBe(records.at(0)?.entityKey);
  expect(read).toHaveBeenCalledTimes(1);
  expect(held.at(-1)?.entityKey).toBe(records.at(-1)?.entityKey);
  const first = records.at(0);
  if (first === undefined) throw new Error('missing residual');
  const unavailable = input.shared.unavailableSlots.with(first.slot);
  const next = f.view.cull({ ...input, shared: { ...input.shared, unavailableSlots: unavailable } })
    .frame.gpuOwned;
  expect(next?.residualSlots(input.gpuSelection).length).toBe(records.length - 1);
  expect(records.at(0)).toBe(first);
  expect(held.at(0)?.entityKey).toBe(first.entityKey);
  const recovered = f.view.cull(input).frame.gpuOwned;
  expect(recovered?.residualSlots(input.gpuSelection).length).toBe(records.length);
});

it('keeps nested residual walks independent when an inner walk returns early', () => {
  const f = cullFixture(64);
  const input = f.current();
  const frame = f.view.cull(input).frame.gpuOwned;
  if (frame === undefined || input.gpuSelection === undefined) throw Error('Missing GPU frame');
  const rows = frame.residualSlots(input.gpuSelection);
  const outer = rows[Symbol.iterator]();
  const inner = rows[Symbol.iterator]();
  const first = outer.next().value;
  expect(first).toBe(rows.at(0));
  expect(inner.next().value).toBe(first);
  inner.return?.();
  expect(inner.next().done).toBe(true);
  expect(outer.next().value).toBe(rows.at(1));
  expect(first).toBe(rows.at(0));
  outer.return?.();
  expect(outer.next().done).toBe(true);
  expect([...rows].map((row) => row.slot)).toEqual(rows.map((row) => row.slot));
});

it('does not submit membership edits for published rows whose readable membership is unchanged', () => {
  const f = cullFixture(1000);
  const current = (beforeRead?: () => void) => {
    const input = f.current();
    const frame = f.view.cull(input).frame.gpuOwned;
    if (frame === undefined || input.gpuSelection === undefined) throw Error('Missing GPU frame');
    beforeRead?.();
    return frame.residualSlots(input.gpuSelection);
  };
  const before = current();
  const entity = before.at(0)?.entityKey;
  if (entity === undefined) throw Error('Missing residual row');
  const edit = vi.spyOn(FrameSet.prototype, 'edit');
  try {
    // A real row publication can change pose without changing whether it is readable.
    const snapshot = source(entity, residual);
    const world = new Float32Array(snapshot.transform.world);
    world[12] = 17;
    f.write([{ ...snapshot, transform: { world } }]);
    // Cull also updates other legitimate memberships; observe only the lazy read owner.
    const after = current(() => edit.mockClear());
    expect(after.length).toBe(before.length);
    expect(after.at(0)?.entityKey).toBe(before.at(0)?.entityKey);
    expect(after.at(0)?.snapshot.transform.world[12]).toBe(17);
    expect(before.at(0)?.snapshot.transform.world[12]).not.toBe(17);
    expect(edit.mock.calls.filter(([edits]) => edits.size > 0)).toEqual([]);
  } finally {
    edit.mockRestore();
  }
});

it('rejudges borrowed selection routes after an in-place binding-domain edit', () => {
  const f = fixture(1);
  const seed = f.topology.sourcePlan().batches.at(0);
  if (seed?.binding === undefined) throw Error('missing binding');
  const binding = { ...seed.binding };
  f.sync(new GpuDrawSelection([{ ...seed, binding }]));
  expect(f.entities()).not.toContain(0);
  binding.worldId = 1;
  f.sync(new GpuDrawSelection([{ ...seed, binding }]));
  expect(f.entities()).toContain(0);
});
