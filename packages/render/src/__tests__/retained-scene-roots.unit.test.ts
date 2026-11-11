import { createBoxGeometry } from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect, test, vi } from 'vitest';
import { MaterialResource } from '../material-resource';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import { setSceneRow } from '../scene/__tests__/scene-row-writes';
import {
  FrameProjection,
  lodCandidateCountOf,
  RetainedFrameProjection,
  sparseRowsOf,
} from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
import { MaterialFrame } from '../scene/material-dispatch';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { RowViews, SceneSlotFrame, SceneSlots } from '../scene/scene-slots';
import { standardSceneDataContributorForDispatch } from '../temporal/standard-scene-data-admission';
import { standardSceneDataContributorAt } from '../world/feature-view-systems';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing retained scene fixture value');
  return value;
}

function source(entityKey: number, x: number, material: MaterialResource): RenderableSnapshot {
  const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
  return {
    worldId: 0,
    entityKey,
    assetHandle: 1,
    transform: { world },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
  };
}

function update(scene: RenderScene, snapshot: RenderableSnapshot): void {
  scene.apply([
    { kind: 'update', worldId: snapshot.worldId, entityKey: snapshot.entityKey, snapshot },
  ]);
}

function surfaceDispatch(material: MaterialResource, renderableIndex = 0): DispatchEntry {
  return {
    entityIndex: 0,
    renderableIndex,
    queue: 2000,
    layer: 0,
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialHandle: material.snapshot.materialHandle ?? 0,
    materialShaderId: undefined,
    passIndex: 0,
    tags: { LightMode: 'Forward' },
  };
}

test('lazy draw callbacks retain identity, submitted pose and material versions through slot reuse', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const oldMaterials = new MaterialFrame(undefined).with(material);
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  update(scene, source(7, 1, material));
  scene.commitSubmission(scene.captureSubmission([source(7, 1, material)]));
  update(scene, source(7, 3, material));
  const frame = scene.slotsSnapshot();
  const draw = scene.drawFrame(oldMaterials);
  const slot = required(frame.lookup(0, 7)).slot;
  material.adopt({
    ...material.snapshot,
    paramSnapshot: { displacementScale: 1 },
    videoTextureFields: new Map([['displacementTexture', 1 as AssetHandle<'video'>]]),
  });
  const currentDraw = scene.drawFrame(oldMaterials.with(material));
  expect(currentDraw(slot)?.temporal?.reactiveReasons).toContain('displacement-source');
  scene.commitSubmission(scene.captureSubmission([source(7, 3, material)]));
  scene.apply([{ kind: 'remove', worldId: 0, entityKey: 7 }]);
  update(scene, source(8, 99, material));
  expect(scene.slot(0, 8)?.slot).toBe(slot);
  const retained = required(draw(slot));
  expect(retained.entityKey).toBe(7);
  expect(retained.transform.world[12]).toBe(3);
  expect(retained.temporal?.previousTransform.world[12]).toBe(1);
  expect(retained.temporal?.reactiveReasons).not.toContain('displacement-source');
  expect(frame.lookup(0, 8)).toBeUndefined();
});

test('primary material fallback uses only the accepted root and rejects missing versions', () => {
  const material = new MaterialResource({
    ...defaultMaterialSnapshot(),
    paramSnapshot: { displacementScale: 1 },
    videoTextureFields: new Map([['displacementTexture', 1 as AssetHandle<'video'>]]),
  });
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  update(scene, { ...source(1, 0, material), materials: [] });
  const slot = required(scene.slot(0, 1)).slot;
  expect(
    scene.drawFrame(new MaterialFrame(undefined).with(material))(slot)?.temporal?.reactiveReasons,
  ).toContain('displacement-source');
  expect(() => scene.drawFrame(new MaterialFrame(undefined))(slot)).toThrow(
    'Temporal draw has no accepted material version',
  );
});

test('unchanged slots consume the captured shared Mesh defaults and material memo can revisit old roots', () => {
  const a = new MaterialResource(defaultMaterialSnapshot());
  const b = new MaterialResource({
    ...defaultMaterialSnapshot(),
    paramSnapshot: { displacementScale: 1 },
    videoTextureFields: new Map([['displacementTexture', 1 as AssetHandle<'video'>]]),
  });
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  update(scene, { ...source(1, 0, a), materialOverrides: [] });
  const slot = required(scene.slot(0, 1)).slot;
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const oldMeshes = new MeshFrame().with(0, 1, mesh, [a]);
  const newMeshes = oldMeshes.with(0, 1, mesh, [b]);
  const oldDraw = scene.drawFrame(new MaterialFrame(undefined).with(a), undefined, oldMeshes);
  const newDraw = scene.drawFrame(new MaterialFrame(undefined).with(b), undefined, newMeshes);
  expect(oldDraw(slot)?.material).toBe(a);
  expect(newDraw(slot)?.material).toBe(b);
  expect(newDraw(slot)?.temporal?.reactiveReasons).toContain('displacement-source');
  expect(oldDraw(slot)?.temporal?.reactiveReasons).not.toContain('displacement-source');
  expect(newDraw(slot)?.temporal?.reactiveReasons).toContain('displacement-source');
});

test('raw frame rosters capture Mesh-only revisions without replacing source records', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const scene = new RenderScene();
  update(scene, { ...source(1, 2, material), materialOverrides: [] });
  scene.adoptMesh(0, 1, createBoxGeometry(2, 2, 2).unwrap());
  const record = scene.slot(0, 1);
  const oldFrame = scene.materialize();
  scene.adoptMesh(0, 1, createBoxGeometry(4, 4, 4).unwrap());
  const newFrame = scene.materialize();
  expect(scene.slot(0, 1)).toBe(record);
  expect(newFrame).not.toBe(oldFrame);
  expect(newFrame.at(0)?.localAabb?.[0]).toBe(-2);
  expect(oldFrame.at(0)?.localAabb?.[0]).toBe(-1);
  expect(oldFrame.at(0)?.transform.world[12]).toBe(2);
  expect(scene.materialize()).toBe(newFrame);
  update(scene, source(2, 0, material));
  const custom = scene.slot(0, 2);
  expect(scene.materialize().at(1)).toBe(custom?.snapshot);
});

test('temporal memo values have no strong edge to earlier scene record keys', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const materials = new MaterialFrame(undefined).with(material);
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  const records = new Set<object>();
  for (let x = 0; x < 40; x++) {
    update(scene, source(1, x, material));
    const record = required(scene.slot(0, 1));
    records.add(record);
    scene.drawFrame(materials)(record.slot);
    scene.commitSubmission(scene.captureSubmission([record.snapshot]));
  }
  const current = required(scene.slot(0, 1));
  const memo = required(
    (scene as unknown as { temporalBySlot: WeakMap<object, object> }).temporalBySlot.get(current),
  );
  const visited = new Set<object>(),
    pending: unknown[] = [memo];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || visited.has(value)) continue;
    expect(records.has(value)).toBe(false);
    visited.add(value);
    if (!ArrayBuffer.isView(value)) pending.push(...Object.values(value));
  }
});

test('disable and reset release owner temporal caches without old views repopulating them', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const materials = new MaterialFrame(undefined).with(material);
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  update(scene, source(1, 1, material));
  scene.commitSubmission(scene.captureSubmission(scene.materialize()));
  update(scene, source(1, 2, material));
  const record = required(scene.slot(0, 1));
  const oldView = scene.drawFrame(materials);
  const oldList = scene.materializeTemporal({ hits: 0, misses: 0 }, materials);
  const cache = () =>
    (scene as unknown as { temporalBySlot: WeakMap<object, object> }).temporalBySlot;
  const before = cache();
  expect(oldView(record.slot)?.temporal?.previousTransform.world[12]).toBe(1);
  expect(before.has(record)).toBe(true);
  scene.setTemporalTracking(false);
  expect(cache()).not.toBe(before);
  expect(cache().has(record)).toBe(false);
  expect(oldView(record.slot)?.temporal?.previousTransform.world[12]).toBe(1);
  expect(oldList.at(0)?.temporal?.previousTransform.world[12]).toBe(1);
  expect(cache().has(record)).toBe(false);
  scene.reset([source(1, 10, material)]);
  const resetCache = cache();
  scene.setTemporalTracking(true);
  const current = required(scene.slot(0, 1));
  expect(oldList.at(0)?.transform.world[12]).toBe(2);
  expect(resetCache.has(record)).toBe(false);
  expect(resetCache.has(current)).toBe(false);
  expect(scene.drawFrame(materials)(current.slot)?.transform.world[12]).toBe(10);
  expect(resetCache.has(current)).toBe(true);
});

test('old and new bounds remain independent across updates, geometry versions and slot reuse', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const materials = new MaterialFrame(undefined).with(material);
  const scene = new RenderScene();
  update(scene, source(1, 0, material));
  const old = required(scene.slot(0, 1));
  const mesh = createBoxGeometry(2, 2, 2).unwrap();
  const meshes = new MeshFrame().with(0, 1, mesh);
  const oldBounds = required(scene.cullingWorldBoundsAt(old, meshes, materials));
  scene.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
  update(scene, source(2, 10, material));
  const current = required(scene.slot(0, 2));
  expect(current.slot).toBe(old.slot);
  expect(scene.cullingWorldBoundsAt(current, meshes, materials)?.min[0]).toBe(9);
  expect(scene.cullingWorldBoundsAt(old, meshes, materials)).toEqual(oldBounds);
  const wide = meshes.with(0, 1, createBoxGeometry(4, 4, 4).unwrap());
  expect(scene.cullingWorldBoundsAt(old, wide, materials)?.min[0]).toBe(-2);
  expect(oldBounds.min[0]).toBe(-1);
  expect(scene.cullingWorldBoundsAt(old, meshes, materials)).toEqual(oldBounds);
  // A captured older record never replaces the current row's RenderBounds column.
  expect(scene.cullingWorldBoundsAt(current, meshes, materials)?.min[0]).toBe(9);
});

test('RenderBounds is a numeric slot column proven by row, geometry and material frame', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const materials = new MaterialFrame(undefined).with(material);
  const scene = new RenderScene();
  update(scene, source(1, 0, material));
  const row = required(scene.slot(0, 1));
  const meshes = new MeshFrame().with(0, 1, createBoxGeometry(2, 2, 2).unwrap());
  const columns = (scene.sceneRows as unknown as { bounds: { radius: Float64Array } }).bounds;
  expect(columns.radius).toBeInstanceOf(Float64Array);
  const out = box3.create();
  expect(scene.writeCullingWorldBoundsAt(row, out, meshes, materials)).toBe(true);
  expect([...out]).toEqual([-1, -1, -1, 1, 1, 1]);
  update(scene, source(1, 5, material));
  const moved = required(scene.slot(0, 1));
  expect(scene.writeCullingWorldBoundsAt(moved, out, meshes, materials)).toBe(true);
  expect(out[0]).toBe(4);
  // The previous record still derives its own bounds without disturbing the row.
  expect(scene.cullingWorldBoundsAt(row, meshes, materials)?.min[0]).toBe(-1);
  expect(scene.cullingWorldBoundsAt(moved, meshes, materials)?.min[0]).toBe(4);
});

test('exact address writes reject aliases atomically and immutable membership survives retirement', () => {
  const owner = new SceneSlots();
  const material = new MaterialResource(defaultMaterialSnapshot());
  const record = {
    slot: 1,
    generation: 1,
    worldId: 0,
    entityKey: 1,
    snapshot: source(1, 0, material),
  };
  setSceneRow(owner, 1, record);
  const retained = owner.capture();
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(owner.get(invalid)).toBeUndefined();
    expect(retained.slotAt(invalid)).toBeUndefined();
    expect(retained.indexOfSlot(invalid)).toBeUndefined();
    expect(() => setSceneRow(owner, invalid, undefined)).toThrow(RangeError);
    expect(owner.capture()).toBe(retained);
  }
  expect(() => setSceneRow(owner, 2, record)).toThrow(RangeError);
  owner.clear();
  expect(retained.lookup(0, 1)).toMatchObject({ slot: 1, generation: 1, worldId: 0, entityKey: 1 });
  expect(owner.capture().length).toBe(0);
  const members = new FrameSet().with(1).with(2);
  expect([...members.without(1).with(3)]).toEqual([2, 3]);
  expect([...members]).toEqual([1, 2]);
});

test('capturing raw and temporal scene rosters never expands unchanged records', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const materials = new MaterialFrame(undefined).with(material);
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  scene.reset(Array.from({ length: 1000 }, (_, entity) => source(entity, entity, material)));
  const counter = { hits: 0, misses: 0 };
  const iterate = vi.spyOn(SceneSlotFrame.prototype, Symbol.iterator).mockImplementation(() => {
    throw new Error('Whole scene expansion during publication');
  });
  try {
    const read = vi.spyOn(SceneSlotFrame.prototype, 'at').mockImplementation(() => {
      throw new Error('Whole scene indexed scan during publication');
    });
    const [raw, temporal] = (() => {
      try {
        return [scene.materialize(), scene.materializeTemporal(counter, materials)] as const;
      } finally {
        read.mockRestore();
      }
    })();
    expect(counter).toEqual({ hits: 0, misses: 0 });
    expect(raw.length).toBe(1000);
    expect(raw.at(500)?.transform.world[12]).toBe(500);
    expect(temporal.at(500)?.transform.world[12]).toBe(500);
    expect(counter.misses).toBe(1);
    update(scene, source(500, 2000, material));
    const changed = scene.materialize();
    expect(changed.at(500)?.transform.world[12]).toBe(2000);
    expect(raw.at(500)?.transform.world[12]).toBe(500);
    expect(changed.at(499)).toBe(raw.at(499));
    expect(temporal.at(500)?.transform.world[12]).toBe(500);
    expect(iterate).not.toHaveBeenCalled();
  } finally {
    iterate.mockRestore();
  }
});

test('SceneData-only contributor reads leave pose, Mesh draw and temporal rows lazy', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  update(scene, { ...source(7, 3, material), materialOverrides: [material] });
  scene.adoptMesh(0, 1, createBoxGeometry(2, 2, 2).unwrap());
  const counters = { hits: 0, misses: 0 };
  const rows = scene.materializeTemporal(counters, new MaterialFrame(undefined).with(material));
  const dispatch = surfaceDispatch(material);
  const read = vi.spyOn(RowViews.prototype, 'read');
  try {
    const contributor = standardSceneDataContributorAt(rows, dispatch, 'forward');
    expect(contributor?.facts?.sourceTuple).toEqual([0, 7, dispatch.materialHandle, 0]);
    expect(read).not.toHaveBeenCalled();
    expect(counters).toEqual({ hits: 0, misses: 0 });
    // A later actual draw still owns the full projection, with identical judgement.
    const draw = required(rows.at(0));
    expect(draw.transform.world[12]).toBe(3);
    expect(draw.localAabb?.[0]).toBe(-1);
    expect(draw.temporal).toBeDefined();
    expect(standardSceneDataContributorForDispatch(draw, dispatch, 'forward')).toEqual(contributor);
    expect(counters.misses).toBe(1);
  } finally {
    read.mockRestore();
  }
});

test('surface columns retain rank holes, captured generations and consecutive pose frames', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const scene = new RenderScene();
  for (const key of [1, 2, 3]) update(scene, source(key, key, material));
  scene.apply([{ kind: 'remove', worldId: 0, entityKey: 2 }]);
  const held = scene.materialize();
  const dispatch = surfaceDispatch(material, 1);
  const read = vi.spyOn(RowViews.prototype, 'read');
  try {
    for (let frame = 0; frame < 4; frame++) {
      scene.apply([
        {
          kind: 'update',
          worldId: 0,
          entityKey: 3,
          world: source(3, frame, material).transform.world,
        },
      ]);
      read.mockClear();
      expect(
        standardSceneDataContributorAt(scene.materialize(), dispatch, 'forward')?.facts
          ?.sourceTuple?.[1],
      ).toBe(3);
      expect(read).not.toHaveBeenCalled();
    }
    scene.apply([{ kind: 'remove', worldId: 0, entityKey: 3 }]);
    update(scene, source(99, 99, material));
    expect(standardSceneDataContributorAt(held, dispatch, 'forward')?.facts?.sourceTuple?.[1]).toBe(
      3,
    );
    expect(held.at(1)?.transform.world[12]).toBe(3);
    const current = scene.materialize();
    for (let index = 0; index < current.length; index++)
      expect(
        standardSceneDataContributorAt(current, surfaceDispatch(material, index), 'forward'),
      ).toEqual(
        standardSceneDataContributorForDispatch(
          current.at(index),
          surfaceDispatch(material, index),
          'forward',
        ),
      );
  } finally {
    read.mockRestore();
  }
});

test('surface columns retain unavailable raw materials, accepted-version errors and recovery', () => {
  const raw = new MaterialResource({ ...defaultMaterialSnapshot(), materialHandle: 101 });
  const effective = new MaterialResource({ ...defaultMaterialSnapshot(), materialHandle: 202 });
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  update(scene, { ...source(7, 0, raw), materialOverrides: [effective] });
  scene.adoptMesh(0, 1, createBoxGeometry(2, 2, 2).unwrap());
  let pending = true;
  class LiveUnavailable extends FrameSet {
    override has() {
      return pending;
    }
  }
  const rows = scene.materializeTemporal(
    { hits: 0, misses: 0 },
    new MaterialFrame(undefined).with(effective),
    new LiveUnavailable(),
  );
  expect(standardSceneDataContributorAt(rows, surfaceDispatch(raw), 'forward')).toEqual(
    standardSceneDataContributorForDispatch(rows.at(0), surfaceDispatch(raw), 'forward'),
  );
  pending = false;
  expect(standardSceneDataContributorAt(rows, surfaceDispatch(effective), 'forward')).toEqual(
    standardSceneDataContributorForDispatch(rows.at(0), surfaceDispatch(effective), 'forward'),
  );
  const missing = scene.materializeTemporal({ hits: 0, misses: 0 }, new MaterialFrame(undefined));
  expect(() =>
    standardSceneDataContributorAt(missing, surfaceDispatch(effective), 'forward'),
  ).toThrow('Temporal draw has no accepted material version');
  expect(() => missing.at(0)).toThrow('Temporal draw has no accepted material version');
});

test('missing native ranks preserve the missing-snapshot contributor judgement', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const scene = new RenderScene();
  const check = (rows: ReturnType<RenderScene['materialize']>) => {
    for (const index of [0, 1, -2, Infinity, -Infinity]) {
      const dispatch = surfaceDispatch(material, index);
      expect(standardSceneDataContributorAt(rows, dispatch, 'forward')).toEqual(
        standardSceneDataContributorForDispatch(rows.at(index), dispatch, 'forward'),
      );
      expect(
        standardSceneDataContributorAt(rows, dispatch, 'forward')?.facts?.materialSnapshotMissing,
      ).toBe(true);
    }
  };
  check(scene.materialize());
  update(scene, source(7, 0, material));
  const rows = scene.materialize();
  for (const index of [1, 100, -2]) {
    const dispatch = surfaceDispatch(material, index);
    expect(standardSceneDataContributorAt(rows, dispatch, 'forward')).toEqual(
      standardSceneDataContributorForDispatch(undefined, dispatch, 'forward'),
    );
  }
});

test.each([
  'source',
  'project',
] as const)('a transferred surface reader preserves the custom %s projection', (kind) => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const scene = new RenderScene();
  update(scene, source(7, 3, material));
  const owned = scene.materialize();
  const reader = FrameProjection.rowReaderOf(owned, owned.at);
  expect(reader).toBeDefined();
  const replacement = source(99, 17, material);
  const project = vi.fn(() => replacement);
  const custom =
    kind === 'source'
      ? new FrameProjection([replacement], project, reader)
      : new FrameProjection(scene.slotsSnapshot(), project, reader);
  const dispatch = surfaceDispatch(material);
  const expected = standardSceneDataContributorForDispatch(custom.at(0), dispatch, 'forward');
  project.mockClear();
  const actual = standardSceneDataContributorAt(custom, dispatch, 'forward');
  expect(actual).toEqual(expected);
  expect(actual?.facts?.sourceTuple?.[1]).toBe(99);
  expect(project).toHaveBeenCalledTimes(1);
});

test('surface fallback observes custom and overridden at getters once with their original receiver', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const scene = new RenderScene();
  update(scene, source(7, 0, material));
  const dispatch = surfaceDispatch(material);
  for (const target of [
    scene.materialize(),
    new FrameProjection([source(8, 0, material)], (row) => row),
  ]) {
    let gets = 0;
    Object.defineProperty(target, 'at', {
      configurable: true,
      get() {
        if (++gets > 1) throw new Error('at was read twice');
        return function (this: unknown) {
          expect(this).toBe(target);
          return source(9, 0, material);
        };
      },
    });
    expect(
      standardSceneDataContributorAt(target, dispatch, 'forward')?.facts?.sourceTuple?.[1],
    ).toBe(9);
    expect(gets).toBe(1);
  }
  const rows = scene.materializeTemporal(
    { hits: 0, misses: 0 },
    new MaterialFrame(undefined).with(material),
  );
  const slots = scene.slotsSnapshot();
  let gets = 0;
  const original = slots.at;
  Object.defineProperty(slots, 'at', {
    configurable: true,
    get() {
      if (++gets > 1) throw new Error('source at was read twice');
      return original;
    },
  });
  expect(standardSceneDataContributorAt(rows, dispatch, 'forward')?.facts?.sourceTuple?.[1]).toBe(
    7,
  );
  expect(gets).toBe(1);
  Object.defineProperty(rows, 'at', {
    get() {
      throw new Error('borrowed at failure');
    },
  });
  expect(() => standardSceneDataContributorAt(rows, dispatch, 'forward')).toThrow(
    'borrowed at failure',
  );
});

test('surface fallback preserves overridden projection length reads and exceptions', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const scene = new RenderScene();
  update(scene, source(7, 0, material));
  const rows = scene.materialize();
  Object.defineProperty(rows, 'length', {
    configurable: true,
    get() {
      throw new Error('live length failure');
    },
  });
  expect(() => standardSceneDataContributorAt(rows, surfaceDispatch(material), 'forward')).toThrow(
    'live length failure',
  );
  Object.defineProperty(rows, 'length', { configurable: true, value: 0 });
  expect(standardSceneDataContributorAt(rows, surfaceDispatch(material), 'forward')).toEqual(
    standardSceneDataContributorForDispatch(undefined, surfaceDispatch(material), 'forward'),
  );
});

test('surface fallback preserves source length normalization and index-getter writes', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  for (const value of [NaN, undefined, 0]) {
    const scene = new RenderScene();
    update(scene, source(7, 0, material));
    const rows = scene.materialize();
    Object.defineProperty(scene.slotsSnapshot(), 'length', { value });
    const dispatch = surfaceDispatch(material, -1);
    expect(standardSceneDataContributorAt(rows, dispatch, 'forward')).toEqual(
      standardSceneDataContributorForDispatch(rows.at(-1), dispatch, 'forward'),
    );
  }
  const scene = new RenderScene();
  update(scene, source(7, 0, material));
  const rows = scene.materialize();
  const dispatch = {
    ...surfaceDispatch(material),
    get renderableIndex() {
      Object.defineProperty(scene.slotsSnapshot(), 'at', {
        get() {
          throw new Error('index changed source reader');
        },
      });
      return 0;
    },
  };
  expect(() => standardSceneDataContributorAt(rows, dispatch, 'forward')).toThrow(
    'index changed source reader',
  );
});

test('lazy projection preserves exact Array.at boundaries without accidental double wrapping', () => {
  const projected = new FrameProjection([1, 2, 3], (value) => value * 2);
  expect(projected.at(-4)).toBeUndefined();
  expect(projected.at(3)).toBeUndefined();
  expect(projected.at(-3)).toBe(2);
  expect(projected.at(-1)).toBe(6);
  expect(projected.at(NaN)).toBe(2);
  expect(projected.at(Infinity)).toBeUndefined();
  expect(projected.at(-Infinity)).toBeUndefined();
  expect(projected.at(1.9)).toBe(4);
  const optional = new FrameProjection([undefined, 2], (value) =>
    value === undefined ? 99 : value * 2,
  );
  expect(optional.at(0)).toBe(99);
  expect([...optional]).toEqual([99, 4]);
  const undefinedValue = new FrameProjection([1, 2], (value) =>
    value === 1 ? undefined : value * 2,
  );
  expect(undefinedValue.slice()).toEqual([undefined, 4]);
  expect([...undefinedValue]).toEqual([undefined, 4]);
});

test('temporal rows carry the Scene-maintained LOD count and sparse rows equal to walking them', () => {
  const material = new MaterialResource(defaultMaterialSnapshot());
  const materials = new MaterialFrame(undefined).with(material);
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  const rows: RenderableSnapshot[] = [];
  for (let key = 1; key <= 12; key++) {
    const row: RenderableSnapshot = {
      ...source(key, key, material),
      ...(key % 3 === 0 ? { lods: [{} as never] } : {}),
      ...(key % 4 === 0 ? { capsuleShadowRequested: true } : {}),
    } as RenderableSnapshot;
    rows.push(row);
    update(scene, row);
  }
  scene.commitSubmission(scene.captureSubmission(scene.materialize()));
  update(scene, { ...(rows[2] as RenderableSnapshot), transform: rows[5]?.transform } as never);
  const temporal = scene.materializeTemporal({ hits: 0, misses: 0 }, materials);
  const walked = [...temporal];
  // The count is read from the facts, not by walking the rows.
  expect(temporal instanceof RetainedFrameProjection && temporal.facts !== undefined).toBe(true);
  expect(lodCandidateCountOf(temporal)).toBe(
    walked.filter((row) => (row.lods?.length ?? 0) > 0).length,
  );
  expect(lodCandidateCountOf(temporal)).toBe(4);
  expect([...sparseRowsOf(temporal, 'capsule')]).toEqual(
    walked.filter((row) => row.capsuleShadowRequested === true),
  );
  for (const row of sparseRowsOf(temporal, 'capsule')) expect(row.temporal).toBeDefined();
  // Rows pending acceptance keep the walked count.
  const unavailable = FrameSet.from([required(scene.slot(0, 3)).slot]);
  const pending = scene.materializeTemporal({ hits: 0, misses: 0 }, materials, unavailable);
  expect(lodCandidateCountOf(pending)).toBe(
    [...pending].filter((row) => (row.lods?.length ?? 0) > 0).length,
  );
});
