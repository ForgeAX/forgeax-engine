import { vec3 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { MaterialResource } from '../../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../../render-system-extract';
import { setSceneRow } from '../../scene/__tests__/scene-row-writes';
import type { FrameList } from '../../scene/frame-list';
import { MaterialDispatch } from '../../scene/material-dispatch';
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
      worldId: 0,
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
    setSceneRow(slots, id, { slot: id, generation: 1, worldId: 0, entityKey: id, snapshot });
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
