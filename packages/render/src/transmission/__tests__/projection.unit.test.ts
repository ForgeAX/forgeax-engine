import { expect, it } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { MaterialResource } from '../../material-resource';
import type { RenderableSnapshot } from '../../render-system-extract';
import { setSceneRow } from '../../scene/__tests__/scene-row-writes';
import { MaterialDispatch } from '../../scene/material-dispatch';
import { SceneSlots } from '../../scene/scene-slots';

function query(dispatch: MaterialDispatch, sources: readonly RenderableSnapshot[]) {
  const slots = new SceneSlots();
  for (const snapshot of sources)
    setSceneRow(slots, snapshot.entityKey, {
      slot: snapshot.entityKey,
      generation: 1,
      worldId: snapshot.worldId,
      entityKey: snapshot.entityKey,
      snapshot,
    });
  dispatch.query(slots.capture());
}

it('adopts one shared transmission update without reading its 10000 source bindings', () => {
  const base = receiptRow().source;
  const material = new MaterialResource({
    ...base.material.snapshot,
    materialShaderId: 'forgeax::default-standard-pbr',
    paramSnapshot: { transmission: 0, roughness: 0 },
  });
  const dispatch = new MaterialDispatch();
  const sources = Array.from({ length: 10_000 }, (_, entityKey) => ({
    ...base,
    entityKey,
    material,
    materials: [material],
  }));
  for (const source of sources) dispatch.bind(source.entityKey, source);
  query(dispatch, sources);
  const before = dispatch.materials();
  for (const source of sources)
    Object.defineProperty(source, 'materials', {
      get() {
        throw new Error('asset adoption enumerated a source binding');
      },
    });
  material.adopt({ ...material.snapshot, paramSnapshot: { transmission: 0.8, roughness: 0.4 } });
  dispatch.adopt(material);
  const rough = dispatch.materials();
  expect(rough.transmissionDemand).toEqual({ activeCount: 10_000, needsRoughMips: true });
  expect(before.transmissionDemand).toEqual({ activeCount: 0, needsRoughMips: false });
  expect(dispatch.materials()).toBe(rough);
  material.adopt({ ...material.snapshot, paramSnapshot: { transmission: 0.8, roughness: 0 } });
  dispatch.adopt(material);
  expect(dispatch.materials().transmissionDemand).toEqual({
    activeCount: 10_000,
    needsRoughMips: false,
  });
  expect(rough.transmissionDemand).toEqual({ activeCount: 10_000, needsRoughMips: true });
  material.adopt({ ...material.snapshot, paramSnapshot: { transmission: 0, roughness: 0.5 } });
  dispatch.adopt(material);
  expect(dispatch.materials().transmissionDemand).toEqual({
    activeCount: 0,
    needsRoughMips: false,
  });
});

it('updates demand on hide, rebind and removal without admitting a newer live material', () => {
  const base = receiptRow().source;
  const material = new MaterialResource({
    ...base.material.snapshot,
    materialShaderId: 'forgeax::default-standard-pbr',
    paramSnapshot: { transmission: 0.8, roughness: 0.2 },
  });
  const dispatch = new MaterialDispatch();
  const source = { ...base, material, materials: [material] };
  const sources = [
    { ...source, entityKey: 0 },
    { ...source, entityKey: 1 },
    { ...source, entityKey: 2, authorVisible: false },
  ];
  for (const row of sources) dispatch.bind(row.entityKey, row);
  query(dispatch, sources);
  expect(dispatch.materials().transmissionDemand.activeCount).toBe(2);
  const held = dispatch.materials();
  material.adopt({ ...material.snapshot, paramSnapshot: { transmission: 0, roughness: 0 } });
  dispatch.remove(0);
  query(dispatch, sources.slice(1));
  expect(dispatch.materials().transmissionDemand.activeCount).toBe(1);
  expect(held.transmissionDemand.activeCount).toBe(2);
  dispatch.adopt(material);
  expect(dispatch.materials().transmissionDemand.activeCount).toBe(0);
  material.adopt({ ...material.snapshot, surfaceModel: 'single-layer-medium' });
  dispatch.adopt(material);
  expect(dispatch.materials().hasMedium).toBe(true);
  dispatch.bind(1, { ...source, entityKey: 1, authorVisible: false });
  sources[1] = { ...source, entityKey: 1, authorVisible: false };
  query(dispatch, sources.slice(1));
  expect(dispatch.materials().hasMedium).toBe(false);
  dispatch.bind(2, { ...source, entityKey: 2 });
  sources[2] = { ...source, entityKey: 2 };
  query(dispatch, sources.slice(1));
  expect(dispatch.materials().hasMedium).toBe(true);
  dispatch.remove(1);
  dispatch.remove(2);
  expect(dispatch.materials().hasMedium).toBe(false);
  expect(dispatch.materials().get(material)).toBeUndefined();
});
