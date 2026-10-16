import { describe, expect, it } from 'vitest';
import {
  adoptFieldEdit,
  diffFieldEdit,
  fieldEditBounds,
  fieldEditState,
  fieldInputsUnchanged,
  fieldOutsideEmpty,
  fieldSourceSlots,
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
  adoptFieldEdit(state, diffFieldEdit(state, moved.sources, moved.instances));
  expect(fieldOutsideEmpty(state, grid)).toBe(false);
  const removed = scene([]);
  adoptFieldEdit(state, diffFieldEdit(state, removed.sources, removed.instances));
  expect(fieldOutsideEmpty(state, grid)).toBe(true);
  const added = scene([{ key: 2, x: -0.6 }]);
  adoptFieldEdit(state, diffFieldEdit(state, added.sources, added.instances), [0]);
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
  finiteEntry.transform[12] = NaN;
  expect(fieldOutsideEmpty(finiteState, grid)).toBe(false);
});

it('diffs moves and removals of owned identities against their owned rows', () => {
  const base = scene([
    { key: 1, x: 0 },
    { key: 2, x: 4 },
  ]);
  const state = fieldEditState(base.sources, base.instances);
  expect(diffFieldEdit(state, base.sources, base.instances)).toEqual(none);

  const moved = scene([
    { key: 1, x: 0 },
    { key: 2, x: 6 },
  ]);
  // Re-projection may renumber rows; the edit addresses the field's owned row.
  const edit = diffFieldEdit(state, moved.sources, moved.instances);
  expect(edit.moved.map((m) => [m.index, m.to[12]])).toEqual([[1, 6]]);
  expect(edit.removed).toEqual([]);
  expect(fieldEditBounds(edit)).toEqual([
    { min: [3.5, -0.5, -0.5], max: [4.5, 0.5, 0.5] },
    { min: [5.5, -0.5, -0.5], max: [6.5, 0.5, 0.5] },
  ]);
  adoptFieldEdit(state, edit);
  expect(diffFieldEdit(state, moved.sources, moved.instances)).toEqual(none);

  const removed = scene([{ key: 2, x: 6 }]);
  expect(diffFieldEdit(state, removed.sources, removed.instances)).toMatchObject({
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
  const edit = diffFieldEdit(state, added.sources, added.instances);
  expect(edit.moved).toEqual([]);
  expect(edit.removed).toEqual([]);
  expect(edit.rematerialized).toEqual([]);
  expect(edit.added.map((a) => [a.id, a.instance.instanceId])).toEqual([['0:3:3:1:0', 1]]);
  // Only the add's own box changes the Global SDF.
  expect(fieldEditBounds(edit)).toEqual([{ min: [8.5, -0.5, -0.5], max: [9.5, 0.5, 0.5] }]);
  expect(() => adoptFieldEdit(state, edit)).toThrow(/one row each/);
  adoptFieldEdit(state, edit, [7]);
  expect(state.get('0:3:3:1:0')?.index).toBe(7);
  expect(diffFieldEdit(state, added.sources, added.instances)).toEqual(none);
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
  const edit = diffFieldEdit(state, repainted.sources, repainted.instances);
  expect(edit.added).toEqual([]);
  expect(edit.removed).toEqual([]);
  expect(edit.moved.map((m) => m.index)).toEqual([1]);
  expect(edit.rematerialized.map((r) => [r.index, r.instance.transform[12]])).toEqual([[1, 5]]);
  // A material change alone recomposes no SDF voxels.
  expect(fieldEditBounds({ ...edit, moved: [] })).toEqual([]);
  adoptFieldEdit(state, edit);
  expect(diffFieldEdit(state, repainted.sources, repainted.instances)).toEqual(none);

  const remeshed = scene([
    { key: 1, x: 0, mesh: {} },
    { key: 2, x: 5, material: white },
  ]);
  const replaced = diffFieldEdit(state, remeshed.sources, remeshed.instances);
  expect(replaced.removed.map((r) => r.index)).toEqual([0]);
  expect(replaced.added.map((a) => a.id)).toEqual(['0:1:1:1:0']);
  expect(replaced.rematerialized).toEqual([]);
  // The replacement may reuse its own freed row.
  adoptFieldEdit(state, replaced, [0]);
  expect(state.get('0:1:1:1:0')?.index).toBe(0);
  expect(diffFieldEdit(state, remeshed.sources, remeshed.instances)).toEqual(none);
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

describe('fieldInputsUnchanged', () => {
  const sources = fieldSourceSlots([
    { slot: 0, generation: 1 },
    { slot: 2, generation: 4 },
  ]);
  const live = new Map<number, { generation: number }>([
    [0, { generation: 1 }],
    [2, { generation: 4 }],
    [5, { generation: 1 }],
  ]);
  const slotAt = (slot: number) => live.get(slot);
  const none = () => false;

  it('skips the projection when only non-source slots changed and they project no source', () => {
    expect(fieldInputsUnchanged(sources, [], slotAt, none)).toBe(true);
    expect(fieldInputsUnchanged(sources, [5], slotAt, none)).toBe(true);
    // A changed slot that projects a source (a new field mesh) needs the full path.
    expect(fieldInputsUnchanged(sources, [5], slotAt, () => true)).toBe(false);
  });

  it('re-projects for source changes, removals, recreations and unproven history', () => {
    expect(fieldInputsUnchanged(sources, [2], slotAt, none)).toBe(false);
    expect(fieldInputsUnchanged(sources, undefined, slotAt, none)).toBe(false);
    const removed = (slot: number) => (slot === 2 ? undefined : live.get(slot));
    expect(fieldInputsUnchanged(sources, [], removed, none)).toBe(false);
    const recreated = (slot: number) => (slot === 0 ? { generation: 2 } : live.get(slot));
    expect(fieldInputsUnchanged(sources, [], recreated, none)).toBe(false);
  });
});
