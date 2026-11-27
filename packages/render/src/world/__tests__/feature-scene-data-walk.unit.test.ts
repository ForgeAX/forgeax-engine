import { expect, it, vi } from 'vitest';
import { snapshot } from '../../__tests__/gpu-driven-production-fixture';
import { MaterialResource } from '../../material-resource';
import { setSceneRow } from '../../scene/__tests__/scene-row-writes';
import { FrameSet } from '../../scene/frame-set';
import { MaterialDispatch } from '../../scene/material-dispatch';
import { RenderScene, sceneDrawContentOf, sceneSurfaceRowsOf } from '../../scene/render-scene-view';
import { SceneSlotPage, SceneSlots } from '../../scene/scene-slots';
import { SelectedSceneDrawRows } from '../../scene/selected-draw-rows';
import { walkSceneDataContributors } from '../feature-view-systems';

it('reads native Pass members by their captured slots without round-tripping through frame rank', () => {
  const material = new MaterialResource({
    ...snapshot(1, 1).material.snapshot,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
  });
  const scene = new RenderScene();
  const owner = new MaterialDispatch();
  scene.rebuild(
    Array.from({ length: 32 }, (_, index) => ({
      ...snapshot(index + 1, 1),
      material,
      materials: [material],
    })),
  );
  const frame = scene.slotsSnapshot();
  for (const row of frame) owner.bind(row.slot, row.snapshot);
  const renderables = scene.materialize();
  const rows = sceneSurfaceRowsOf(renderables, renderables.at);
  if (rows === undefined) throw Error('native surface columns unavailable');
  const header = {
    viewIdentity: 'test',
    generation: 0,
    deviceGeneration: 0,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'forward' as const,
  };
  const dispatch = owner.query(frame);
  const flat = walkSceneDataContributors(
    header,
    'forward',
    renderables,
    [...dispatch],
    rows,
    undefined,
  );
  const readRank = vi.spyOn(frame, 'readContentAt');
  const readSlot = vi.spyOn(frame, 'readContentSlot');
  try {
    expect(
      walkSceneDataContributors(header, 'forward', renderables, dispatch, rows, undefined),
    ).toEqual(flat);
    expect(readRank).not.toHaveBeenCalled();
    expect(readSlot).toHaveBeenCalledTimes(32);
    expect(new Set(readSlot.mock.calls.map(([, read]) => read)).size).toBe(1);
    const foreign = new SceneSlots();
    for (const row of frame) setSceneRow(foreign, row.slot, row);
    const foreignDispatch = owner.query(foreign.capture());
    expect(
      walkSceneDataContributors(header, 'forward', renderables, foreignDispatch, rows, undefined),
    ).toEqual(flat);
    expect(readRank).toHaveBeenCalledTimes(32);
  } finally {
    readSlot.mockRestore();
    readRank.mockRestore();
  }
});

it('reads the compact surface rank after culling without projecting a pose or treating a dispatch slot as a view rank', () => {
  const scene = new RenderScene();
  const material = new MaterialResource({
    ...snapshot(1, 1).material.snapshot,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
  });
  const sources = Array.from({ length: 8 }, (_, i) => ({
    ...snapshot(i + 1, 1),
    material,
    materials: [material],
  }));
  scene.rebuild(sources);
  const roster = scene.slotsSnapshot();
  const owner = new MaterialDispatch();
  for (const row of roster) owner.bind(row.slot, row.snapshot);
  const list = scene.materialize();
  const columns = sceneDrawContentOf(list);
  if (columns === undefined) throw new Error('missing captured columns');
  const header = {
    viewIdentity: 'changing',
    generation: 1,
    deviceGeneration: 1,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'forward' as const,
  };
  const entries = [...owner.query(roster)];
  for (let i = 0; i < 8; i++) {
    const selected = new SelectedSceneDrawRows(columns, FrameSet.from([i, (i + 3) % 8]));
    const ordinary = [...selected];
    const dispatch = ordinary.map((row, rank) => {
      const entry = entries.find((entry) => entry.entityIndex === row.entityKey);
      if (entry === undefined) throw new Error('missing material pass');
      return { ...entry, renderableIndex: rank };
    });
    const reference = walkSceneDataContributors(
      header,
      'forward',
      ordinary,
      dispatch,
      undefined,
      undefined,
    );
    const projected = vi.spyOn(SceneSlotPage.prototype, 'read');
    try {
      expect(
        walkSceneDataContributors(
          header,
          'forward',
          selected,
          dispatch,
          sceneSurfaceRowsOf(selected, selected.at),
          undefined,
        ),
      ).toEqual(reference);
      expect(projected).not.toHaveBeenCalled();
      expect(sceneSurfaceRowsOf(selected, ordinary.at)).toBeUndefined();
    } finally {
      projected.mockRestore();
    }
  }
});

it.each([
  'forward',
  'deferred',
] as const)('filters native shared Pass work before reading scene columns (%s)', (lane) => {
  const seed = snapshot(1, 1);
  const material = new MaterialResource({
    ...seed.material.snapshot,
    passes: ['Forward', 'ShadowCaster'].map((name) => ({
      name,
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: name } },
    })),
  });
  const sources = Array.from({ length: 32 }, (_, index) => ({
    ...snapshot(index + 1, 1),
    material,
    materials: [material],
  }));
  const slots = new SceneSlots(),
    owner = new MaterialDispatch();
  for (const [slot, source] of sources.entries()) {
    setSceneRow(slots, slot, { entityKey: source.entityKey, generation: 0, snapshot: source });
    owner.bind(slot, source);
  }
  const dispatch = owner.query(slots.capture());
  type Rows = NonNullable<Parameters<typeof walkSceneDataContributors>[4]>;
  const read = vi.fn((index: number, consume: Parameters<Rows['surfaceWalk']>[0]) => {
    const row = sources[index];
    if (row === undefined) throw new Error('missing fixture row');
    return consume(row.entityKey, row, row);
  });
  const rows = {
    surfaceWalk: (visit: Parameters<Rows['surfaceWalk']>[0]) => ({
      readRank: (rank: number) => read(rank, visit),
    }),
  } as unknown as Rows;
  const header = {
    viewIdentity: 'test',
    generation: 0,
    deviceGeneration: 0,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: lane,
  };
  const native = walkSceneDataContributors(header, lane, sources, dispatch, rows, undefined);
  expect(read).toHaveBeenCalledTimes(32);
  read.mockClear();
  const flat = walkSceneDataContributors(header, lane, sources, [...dispatch], rows, undefined);
  expect(read).toHaveBeenCalledTimes(64);
  expect(native).toEqual(flat);
  const entries = [...dispatch];
  Object.defineProperty(dispatch, Symbol.iterator, {
    value: function* () {
      yield* entries;
    },
  });
  read.mockClear();
  expect(walkSceneDataContributors(header, lane, sources, dispatch, rows, undefined)).toEqual(flat);
  expect(read).toHaveBeenCalledTimes(64);
});

it('classifies a missing writer from its current view before accessing changing Scene rows', () => {
  const material = new MaterialResource({
    ...snapshot(1, 1).material.snapshot,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
  });
  const header = {
    viewIdentity: 'capture',
    generation: 1,
    deviceGeneration: 2,
    standardPipeline: false,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'forward' as const,
  };
  const scene = new RenderScene();
  const owner = new MaterialDispatch();
  const initial = walkSceneDataContributors(header, 'forward', [], [], undefined, undefined);
  for (let frame = 1; frame <= 100; frame++) {
    scene.rebuild([{ ...snapshot(frame, 1), material, materials: [material] }]);
    const slots = scene.slotsSnapshot();
    for (const slot of slots) owner.bind(slot.slot, slot.snapshot);
    const source = scene.materialize();
    const dispatch = owner.query(slots);
    expect(dispatch.length).toBe(1);
    const rows = sceneSurfaceRowsOf(source, source.at);
    if (rows === undefined) throw Error('Missing captured scene columns');
    const read = vi.spyOn(slots, 'readContentSlot');
    const result = walkSceneDataContributors(header, 'forward', source, dispatch, rows, initial);
    expect(result.identity).toBe(initial.identity);
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'producer-missing',
      missingContributorIds: [],
    });
    expect(read).not.toHaveBeenCalled();
    const recovered = walkSceneDataContributors(
      { ...header, standardPipeline: true },
      'forward',
      source,
      dispatch,
      rows,
      result,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(recovered.identity).not.toBe(initial.identity);
    read.mockRestore();
  }
});
