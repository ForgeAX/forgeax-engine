import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, it, vi } from 'vitest';
import {
  adoptFieldEdit,
  diffFieldEdit,
  fieldEditBounds,
  fieldEditState,
  fieldOutsideEmpty,
} from '../../raytracing/field-edit';
import { globalSdfEditBox, packGlobalSdfEditBox } from '../../raytracing/global-sdf';
import { mergeRuns } from '../../raytracing/irradiance-field-edit';
import { ProbeClipmapScheduler } from '../../raytracing/probe-clipmap';
import type { SceneFieldSource } from '../../raytracing/scene-field-projection';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';

const field = {
  bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
  policy: { kind: 'solid' },
};
const translate = (x: number, y = 0, z = 0) =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

const mesh = {};
const lambert = { materialSlot: 0, handle: 1, facts: { baseColor: [1, 1, 1, 1] } };
function scene(entities: readonly { key: number; x: number; mesh?: object; material?: object }[]) {
  const sources = entities.map(
    (e, i) =>
      ({
        worldId: 0,
        entityKey: e.key,
        slot: e.key,
        generation: 1,
        firstInstance: i,
        scope: 's',
        assetHandle: e.mesh === undefined ? 1 : 2,
        assetRevision: 1,
        mesh: e.mesh ?? mesh,
        field,
        materials: [e.material ?? lambert],
      }) as unknown as SceneFieldSource,
  );
  const instances = entities.map(
    (e, i) => ({ instanceId: i, transform: translate(e.x), field }) as unknown as SdfMeshInstance,
  );
  return { sources, instances };
}
const none = { moved: [], removed: [], added: [], rematerialized: [] };

it('replaces managed Mesh field rows when an in-place publication preserves payload identity', () => {
  const assets = new AssetRegistry();
  try {
    const handle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const records = runtimeAssets(assets);
    const mesh = records.borrow(handle).unwrap();
    const base = scene([{ key: 1, x: 0 }]);
    const capture = () =>
      ({
        ...base.sources[0],
        assetHandle: handle,
        assetRevision: records.version(handle).unwrap(),
        mesh,
      }) as SceneFieldSource;
    const state = fieldEditState([capture()], base.instances);
    // Non-geometric Mesh facts may change without replacing the owned object.
    assets.update(handle, { lodHysteresis: 0.25 }).unwrap();
    expect(records.borrow(handle).unwrap()).toBe(mesh);
    const current = capture();
    const edit = diffFieldEdit(state, { sources: [current], instances: base.instances });
    expect(edit.removed.map((row) => row.index)).toEqual([0]);
    expect(edit.added.map((row) => row.id)).toEqual(['0:1:1:1:0']);
    adoptFieldEdit(state, edit, [0]);
    expect(diffFieldEdit(state, { sources: [current], instances: base.instances })).toEqual(none);
  } finally {
    assets.dispose();
  }
});

it('derives empty SDF exterior from adopted trace bounds and revokes it on edits', () => {
  const grid = {
    origin: [-1, -1, -1] as const,
    dimensions: [3, 3, 3] as const,
    spacing: 1,
    maxDistance: 1,
    coverageDistance: 0.5,
  };
  const base = scene([{ key: 1, x: 0.5 }]);
  const state = fieldEditState(base.sources, base.instances);
  expect(fieldOutsideEmpty(state, grid)).toBe(true); // Touching the last sample is covered.
  const moved = scene([{ key: 1, x: 0.6 }]);
  adoptFieldEdit(state, diffFieldEdit(state, moved));
  expect(fieldOutsideEmpty(state, grid)).toBe(false);
  const removed = scene([]);
  adoptFieldEdit(state, diffFieldEdit(state, removed));
  expect(fieldOutsideEmpty(state, grid)).toBe(true);
  const added = scene([{ key: 2, x: -0.6 }]);
  adoptFieldEdit(state, diffFieldEdit(state, added), [0]);
  expect(fieldOutsideEmpty(state, grid)).toBe(false);
  const missing = scene([{ key: 2, x: 0 }]);
  const missingInstance = missing.instances[0];
  if (missingInstance === undefined) throw new Error('missing source instance');
  missing.instances[0] = {
    ...missingInstance,
    field: { missing: true, bounds: { min: [-2, -0.5, -0.5], max: [2, 0.5, 0.5] } },
  };
  const missingState = fieldEditState(missing.sources, missing.instances);
  expect(fieldOutsideEmpty(missingState, grid)).toBe(false);
  const finiteState = fieldEditState(base.sources, base.instances);
  const finiteEntry = finiteState.values().next().value;
  if (finiteEntry === undefined) throw new Error('missing adopted instance');
  expect(fieldOutsideEmpty(finiteState, grid)).toBe(true);
  const invalid = scene([{ key: 1, x: NaN }]);
  adoptFieldEdit(finiteState, diffFieldEdit(finiteState, invalid));
  expect(fieldOutsideEmpty(finiteState, grid)).toBe(false);
});

it('diffs moves and removals of owned identities against their owned rows', () => {
  const base = scene([
    { key: 1, x: 0 },
    { key: 2, x: 4 },
  ]);
  const state = fieldEditState(base.sources, base.instances);
  expect(diffFieldEdit(state, base)).toEqual(none);

  const moved = scene([
    { key: 1, x: 0 },
    { key: 2, x: 6 },
  ]);
  // Re-projection may renumber rows; the edit addresses the field's owned row.
  const edit = diffFieldEdit(state, moved);
  expect(edit.moved.map((m) => [m.index, m.to[12]])).toEqual([[1, 6]]);
  expect(edit.removed).toEqual([]);
  expect(fieldEditBounds(edit)).toEqual([
    { min: [3.5, -0.5, -0.5], max: [4.5, 0.5, 0.5] },
    { min: [5.5, -0.5, -0.5], max: [6.5, 0.5, 0.5] },
  ]);
  adoptFieldEdit(state, edit);
  expect(diffFieldEdit(state, moved)).toEqual(none);

  const removed = scene([{ key: 2, x: 6 }]);
  expect(diffFieldEdit(state, removed)).toMatchObject({
    moved: [],
    removed: [{ index: 0 }],
    added: [],
    rematerialized: [],
  });
});

it('diffs new identities as adds and owns them at the rows the field assigns', () => {
  const base = scene([
    { key: 1, x: 0 },
    { key: 2, x: 4 },
  ]);
  const state = fieldEditState(base.sources, base.instances);
  const added = scene([
    { key: 1, x: 0 },
    { key: 3, x: 9 },
    { key: 2, x: 4 },
  ]);
  const edit = diffFieldEdit(state, added);
  expect(edit.moved).toEqual([]);
  expect(edit.removed).toEqual([]);
  expect(edit.rematerialized).toEqual([]);
  expect(edit.added.map((a) => [a.id, a.instance.instanceId])).toEqual([['0:3:3:1:0', 1]]);
  // Only the add's own box changes the Global SDF.
  expect(fieldEditBounds(edit)).toEqual([{ min: [8.5, -0.5, -0.5], max: [9.5, 0.5, 0.5] }]);
  expect(() => adoptFieldEdit(state, edit)).toThrow(/one row each/);
  adoptFieldEdit(state, edit, [7]);
  expect(state.get('0:3:3:1:0')?.index).toBe(7);
  expect(diffFieldEdit(state, added)).toEqual(none);
});

it('diffs material-only changes in place and mesh changes as removal plus add', () => {
  const base = scene([
    { key: 1, x: 0 },
    { key: 2, x: 4 },
  ]);
  const state = fieldEditState(base.sources, base.instances);
  const white = { materialSlot: 0, handle: 2, facts: { baseColor: [1, 1, 1, 1] } };
  const repainted = scene([
    { key: 1, x: 0 },
    { key: 2, x: 5, material: white },
  ]);
  const edit = diffFieldEdit(state, repainted);
  expect(edit.added).toEqual([]);
  expect(edit.removed).toEqual([]);
  expect(edit.moved.map((m) => m.index)).toEqual([1]);
  expect(edit.rematerialized.map((r) => [r.index, r.instance.transform[12]])).toEqual([[1, 5]]);
  // A material change alone recomposes no SDF voxels.
  expect(fieldEditBounds({ ...edit, moved: [] })).toEqual([]);
  adoptFieldEdit(state, edit);
  expect(diffFieldEdit(state, repainted)).toEqual(none);

  const remeshed = scene([
    { key: 1, x: 0, mesh: {} },
    { key: 2, x: 5, material: white },
  ]);
  const replaced = diffFieldEdit(state, remeshed);
  expect(replaced.removed.map((r) => r.index)).toEqual([0]);
  expect(replaced.added.map((a) => a.id)).toEqual(['0:1:1:1:0']);
  expect(replaced.rematerialized).toEqual([]);
  // The replacement may reuse its own freed row.
  adoptFieldEdit(state, replaced, [0]);
  expect(state.get('0:1:1:1:0')?.index).toBe(0);
  expect(diffFieldEdit(state, remeshed)).toEqual(none);
});

it('bounds Global SDF recomposition to the edited box plus the distance band', () => {
  const grid = {
    origin: [0, 0, 0] as const,
    dimensions: [64, 32, 64] as const,
    spacing: 0.25,
    maxDistance: 0.5,
    coverageDistance: 0.5,
  };
  const box = globalSdfEditBox(grid, [{ min: [4, 1, 4], max: [5, 2, 5] }]);
  expect(box).toEqual({ lo: [13, 1, 13], extent: [11, 11, 11] });
  expect(Array.from(packGlobalSdfEditBox(box))).toEqual([13 | (1 << 8) | (13 << 16), 11 * 0x10101]);
  expect(globalSdfEditBox(grid, [{ min: [-9, -9, -9], max: [99, 99, 99] }])).toBeUndefined();
  expect(globalSdfEditBox(grid, [{ min: [90, 1, 1], max: [91, 2, 2] }])?.extent).toEqual([0, 0, 0]);
  expect(Array.from(packGlobalSdfEditBox(undefined))).toEqual([0, 0]);
});

it('selects the probe box around an edit on every level and merges dirty tile runs', () => {
  const clipmap = new ProbeClipmapScheduler({
    origin: [0, 0, 0],
    spacing: 1,
    dimensions: [8, 4, 8],
    levels: 2,
    follow: false,
    probeCount: 512,
    probeBudget: 64,
    levelBudgets: [43, 21],
  });
  // Two level spacings of margin, clipped to each level's window.
  expect(clipmap.editBoxes([{ min: [3.2, 0, 3.2], max: [3.8, 1, 3.8] }])).toEqual([
    { level: 0, min: [1, 0, 1], max: [7, 4, 7] },
    { level: 1, min: [0, 0, 0], max: [5, 4, 5] },
  ]);
  expect(clipmap.editBoxes([])).toEqual([]);
  expect(
    mergeRuns([
      { first: 8, end: 12 },
      { first: 0, end: 4 },
      { first: 4, end: 6 },
      { first: 11, end: 14 },
      { first: 20, end: 20 },
    ]),
  ).toEqual([
    { first: 0, end: 6 },
    { first: 8, end: 14 },
  ]);
});

it('retains material binding identity across accepted shared-root value updates', () => {
  const resource = {};
  const material = { resource, materialSlot: 0, handle: 1, facts: { baseColor: [1, 0, 0, 1] } };
  const base = scene([{ key: 1, x: 0, material }]);
  const state = fieldEditState(base.sources, base.instances);
  const updated = scene([
    {
      key: 1,
      x: 3,
      material: {
        ...material,
        facts: { baseColor: [0, 1, 0, 1] },
        payload: {},
        projection: {},
      },
    },
  ]);
  const edit = diffFieldEdit(state, updated);
  expect(edit.moved).toHaveLength(1);
  expect(edit.rematerialized).toEqual([]);
  const rebound = scene([{ key: 1, x: 0, material: { ...material, resource: {} } }]);
  expect(diffFieldEdit(state, rebound).rematerialized).toHaveLength(1);
});

it.each([128, 1024])('adopts 8 field edits without enumerating N=%i owned rows', (count) => {
  const initial = scene(Array.from({ length: count }, (_, key) => ({ key, x: key * 4 })));
  const state = fieldEditState(initial.sources, initial.instances);
  const current = scene(
    Array.from({ length: count }, (_, key) => ({ key, x: key * 4 + (key < 8 ? 1 : 0) })),
  );
  const edit = diffFieldEdit(state, current);
  expect(edit.moved).toHaveLength(8);
  const enumerate = vi.spyOn(state, Symbol.iterator);
  adoptFieldEdit(state, edit);
  expect(enumerate).not.toHaveBeenCalled();
  enumerate.mockRestore();
  expect([...state.values()].slice(0, 8).map((row) => row.transform[12])).toEqual(
    Array.from({ length: 8 }, (_, index) => index * 4 + 1),
  );
});

it('updates the SDF exterior proof from adopted rows without scanning clean entries', () => {
  const grid = {
    origin: [-1, -1, -1] as const,
    dimensions: [3, 3, 3] as const,
    spacing: 1,
    maxDistance: 1,
    coverageDistance: 0.5,
  };
  const base = scene(Array.from({ length: 1024 }, (_, key) => ({ key, x: 0 })));
  const state = fieldEditState(base.sources, base.instances);
  expect(fieldOutsideEmpty(state, grid)).toBe(true);
  const enumerate = vi.spyOn(state, 'values');
  const moved = scene([{ key: 7, x: 2 }]);
  const changedSources = [{ worldId: 0, slot: 7 }];
  adoptFieldEdit(state, diffFieldEdit(state, { ...moved, changedSources }));
  expect(fieldOutsideEmpty(state, grid)).toBe(false);
  adoptFieldEdit(state, diffFieldEdit(state, { sources: [], instances: [], changedSources }));
  expect(fieldOutsideEmpty(state, grid)).toBe(true);
  expect(state.size).toBe(1023);
  expect(enumerate).not.toHaveBeenCalled();
  enumerate.mockRestore();
  expect(fieldOutsideEmpty(state, { ...grid, origin: [10, 10, 10] })).toBe(false);
});
