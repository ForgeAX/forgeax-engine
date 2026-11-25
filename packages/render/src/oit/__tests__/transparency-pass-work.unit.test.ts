import { vec3 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { MaterialResource } from '../../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../../render-system-extract';
import { setSceneRow } from '../../scene/__tests__/scene-row-writes';
import type { FrameList } from '../../scene/frame-list';
import { MaterialDispatch } from '../../scene/material-dispatch';
import { SceneDrawSlot } from '../../scene/mesh-draw';
import { RenderScene } from '../../scene/render-scene-view';
import { SceneSlots } from '../../scene/scene-slots';
import { resolveTransparencyView } from '../view';

function material(handle: number, transparent: boolean): MaterialSnapshot {
  return {
    materialHandle: handle,
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    ...(transparent ? { transparent: true } : {}),
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: {
          tags: { LightMode: 'Forward' },
          queue: transparent ? 3000 : 2000,
          ...(transparent
            ? {
                blend: {
                  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                  alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                },
                depthWrite: false,
              }
            : {}),
        },
      },
    ],
  };
}

/** A query over `opaque` rows and `transparent` rows, with counted row reads. */
function scene(opaque: number, transparent: number) {
  const solid = Array.from({ length: 4 }, (_, i) => new MaterialResource(material(i + 1, false)));
  const glass = new MaterialResource(material(100, true));
  const owner = new MaterialDispatch();
  const slots = new SceneSlots();
  const rows: RenderableSnapshot[] = [];
  for (let id = 0; id < opaque + transparent; id++) {
    const resource = id < opaque ? (solid[id % solid.length] as MaterialResource) : glass;
    const snapshot: RenderableSnapshot = {
      entityKey: id,
      assetHandle: 1,
      material: resource,
      materials: [resource],
      materialBindingSources: ['renderer-override'],
      transform: { world: new Float32Array(16) },
      ...(id === opaque
        ? { skinBinding: {} as NonNullable<RenderableSnapshot['skinBinding']> }
        : {}),
    };
    rows.push(snapshot);
    owner.bind(id, snapshot);
    setSceneRow(slots, id, { slot: id, generation: 1, entityKey: id, snapshot });
  }
  const dispatch = owner.query(slots.capture());
  let reads = 0;
  const renderables = {
    length: rows.length,
    at(index: number) {
      reads++;
      return rows[index];
    },
  } as unknown as FrameList<RenderableSnapshot>;
  return {
    dispatch,
    renderables,
    materialFrame: owner.materials(),
    reads: () => reads,
  };
}

it('classifies a query per Pass, reading only transparent members at any scene size', () => {
  const visits: number[] = [];
  for (const opaque of [1000, 10000]) {
    const { dispatch, renderables, materialFrame, reads } = scene(opaque, 8);
    const iterate = vi.spyOn(dispatch, Symbol.iterator);
    const sorted = resolveTransparencyView({
      requested: 'sorted',
      rgba16floatRenderable: true,
      renderables,
      materialFrame,
      dispatch,
    });
    expect(reads()).toBe(0);
    const blended = resolveTransparencyView({
      requested: 'weighted-blended',
      rgba16floatRenderable: true,
      renderables,
      materialFrame,
      dispatch,
    });
    visits.push(reads());
    expect(iterate).not.toHaveBeenCalled();
    expect(sorted.inspection.sortedDrawCount).toBe(8);
    expect(blended.inspection).toMatchObject({ accumulatedDrawCount: 7, sortedDrawCount: 1 });
    expect(blended.inspection.ineligible['program-without-oit-output']).toBe(1);
    // The flat per-entry path is the reference classification.
    const flat = Object.freeze([...dispatch]);
    for (const requested of ['sorted', 'weighted-blended'] as const)
      expect(
        resolveTransparencyView({
          requested,
          rgba16floatRenderable: true,
          renderables,
          materialFrame,
          dispatch: flat,
        }).inspection,
      ).toEqual(requested === 'sorted' ? sorted.inspection : blended.inspection);
  }
  expect(visits).toEqual([8, 8]);
});

it('classifies changing native pass members and skin slots without issuing per-draw rows', () => {
  const render = new RenderScene();
  const owner = new MaterialDispatch();
  const glass = new MaterialResource(material(33, true));
  const count = 120;
  const sources = Array.from(
    { length: count },
    (_, entityKey): RenderableSnapshot => ({
      entityKey,
      assetHandle: 1,
      material: glass,
      materials: [glass],
      materialBindingSources: ['renderer-override'],
      transform: { world: new Float32Array(16) },
    }),
  );
  render.apply(
    sources.map((snapshot) => ({ kind: 'update', entityKey: snapshot.entityKey, snapshot })),
  );
  for (const slot of render.slotsSnapshot()) owner.bind(slot.slot, slot.snapshot);
  const draw = vi.spyOn(SceneDrawSlot.prototype, 'draw');
  try {
    for (let tick = 0; tick < 60; tick++) {
      const base = sources[tick] as RenderableSnapshot;
      const next =
        tick % 3 !== 0 ? { ...base, skinBinding: { skeleton: tick, joints: [1, 2] } } : base;
      render.apply([{ kind: 'update', entityKey: tick, snapshot: next }]);
      const roster = render.slotsSnapshot();
      const dispatch = owner.query(roster);
      const result = resolveTransparencyView({
        requested: 'weighted-blended',
        rgba16floatRenderable: true,
        renderables: render.materialize(),
        materialFrame: owner.materials(),
        dispatch: tick % 2 === 0 ? dispatch : [...dispatch].reverse(),
      });
      const skinned = tick + 1 - (Math.floor(tick / 3) + 1);
      expect(result.inspection.accumulatedDrawCount).toBe(count - skinned);
      expect(result.inspection.sortedDrawCount).toBe(skinned);
      expect(result.inspection.ineligible['program-without-oit-output']).toBe(skinned);
    }
    expect(draw).not.toHaveBeenCalled();
  } finally {
    draw.mockRestore();
  }
});

it('reads the current borrowed skin flag from a fixed dispatch after in-place edits', () => {
  const glass = new MaterialResource(material(9, true));
  const seed: RenderableSnapshot = {
    entityKey: 1,
    assetHandle: 1,
    material: glass,
    materials: [glass],
    transform: { world: new Float32Array(16) },
  };
  const store = new MaterialDispatch();
  const slots = new SceneSlots();
  store.bind(0, seed);
  setSceneRow(slots, 0, { slot: 0, generation: 1, entityKey: 1, snapshot: seed });
  const dispatch = Object.freeze([...store.query(slots.capture())]);
  const rows = [seed];
  const input = {
    requested: 'weighted-blended' as const,
    rgba16floatRenderable: true,
    renderables: rows,
    materialFrame: store.materials(),
    dispatch,
  };
  for (let tick = 0; tick < 9; tick++) {
    const skinned = tick % 2 !== 0;
    rows[0] = skinned ? { ...seed, skinBinding: { skeleton: 1, joints: [7] } } : seed;
    const result = resolveTransparencyView(input);
    expect(result.inspection.accumulatedDrawCount).toBe(Number(!skinned));
    expect(result.inspection.sortedDrawCount).toBe(Number(skinned));
  }
});

it('revisits only changed Pass work of a sorted view across frames of unique materials', () => {
  const count = 2000;
  const resources = Array.from(
    { length: count },
    (_, i) => new MaterialResource(material(i + 1, i === 0)),
  );
  const owner = new MaterialDispatch();
  const slots = new SceneSlots();
  for (const [id, resource] of resources.entries()) {
    const snapshot: RenderableSnapshot = {
      entityKey: id,
      assetHandle: 1,
      material: resource,
      materials: [resource],
      materialBindingSources: ['renderer-override'],
      transform: { world: new Float32Array(16) },
    };
    owner.bind(id, snapshot);
    setSceneRow(slots, id, { slot: id, generation: 1, entityKey: id, snapshot });
  }
  const frame = slots.capture();
  const resolve = () => {
    const dispatch = owner.query(frame);
    const materialFrame = owner.materials();
    const get = vi.spyOn(materialFrame, 'get');
    get.mockClear();
    const renderables = { length: count } as unknown as FrameList<RenderableSnapshot>;
    const sortedDrawCount = resolveTransparencyView({
      requested: 'sorted',
      rgba16floatRenderable: true,
      renderables,
      materialFrame,
      dispatch,
    }).inspection.sortedDrawCount;
    return { sortedDrawCount, reads: get.mock.calls.length };
  };
  expect(resolve()).toEqual({ sortedDrawCount: 1, reads: count });
  expect(resolve()).toEqual({ sortedDrawCount: 1, reads: 0 });
  // Edits that keep the Pass roster revisit only the edited material's work.
  const edited = resources[7] as MaterialResource;
  edited.adopt({ ...edited.snapshot, roughness: 0.9 });
  owner.adopt(edited);
  expect(resolve()).toEqual({ sortedDrawCount: 1, reads: 1 });
  edited.adopt({ ...edited.snapshot, transparent: true });
  owner.adopt(edited);
  expect(resolve()).toEqual({ sortedDrawCount: 2, reads: 1 });
});
