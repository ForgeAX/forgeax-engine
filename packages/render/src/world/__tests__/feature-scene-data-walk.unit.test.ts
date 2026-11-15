import { expect, it, vi } from 'vitest';
import { snapshot } from '../../__tests__/gpu-driven-production-fixture';
import { MaterialResource } from '../../material-resource';
import { setSceneRow } from '../../scene/__tests__/scene-row-writes';
import { MaterialDispatch } from '../../scene/material-dispatch';
import { RenderScene, sceneSurfaceRowsOf } from '../../scene/render-scene-view';
import { SceneSlots } from '../../scene/scene-slots';
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
  try {
    expect(
      walkSceneDataContributors(header, 'forward', renderables, dispatch, rows, undefined),
    ).toEqual(flat);
    expect(readRank).not.toHaveBeenCalled();
    const foreign = new SceneSlots();
    for (const row of frame) setSceneRow(foreign, row.slot, row);
    const foreignDispatch = owner.query(foreign.capture());
    expect(
      walkSceneDataContributors(header, 'forward', renderables, foreignDispatch, rows, undefined),
    ).toEqual(flat);
    expect(readRank).toHaveBeenCalledTimes(32);
  } finally {
    readRank.mockRestore();
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
  const read = vi.fn<Rows['read']>((index, consume) => {
    const row = sources[index];
    if (row === undefined) throw new Error('missing fixture row');
    return consume(row.entityKey, row, row);
  });
  const rows = { read } as unknown as NonNullable<Parameters<typeof walkSceneDataContributors>[4]>;
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
