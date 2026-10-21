import { expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { MaterialResource } from '../../material-resource';
import { resolveTransparencyView } from '../../oit/view';
import { subsurfaceDemand } from '../../subsurface/demand';
import { SubsurfaceSelection } from '../../subsurface/selection';
import { MaterialFrame } from '../material-dispatch';
import { RenderScene } from '../render-scene';

it('recovers from more than seventeen profiles and preserves shared profile references', () => {
  const base = receiptRow().source.material.snapshot;
  const resources = Array.from(
    { length: 33 },
    (_, index) =>
      new MaterialResource({
        ...base,
        surfaceModel: 'standard',
        deferredPass: true,
        paramSnapshot: {
          subsurfaceRadius: [index === 32 ? 0.1 : 0.1 + index / 3, 2, 1],
          subsurfaceWeight: 1,
        },
      }),
  );
  let frame = new MaterialFrame(undefined);
  const selected = new SubsurfaceSelection();
  for (const resource of resources) {
    frame = frame.with(resource);
    selected.add({ material: resource, materials: [resource] }, frame);
  }
  selected.adopt(frame);
  expect(selected.demand).toBe(32);
  for (let index = 0; index < 17; index++) {
    const resource = resources[index];
    assertResource(resource);
    resource.adopt({
      ...resource.snapshot,
      paramSnapshot: { ...resource.snapshot.paramSnapshot, subsurfaceWeight: 0 },
    });
    frame = frame.with(resource);
  }
  selected.adopt(frame);
  // The duplicated first RGB tuple survives through its second resource.
  expect(selected.demand).toBe(16);
  expect(subsurfaceDemand(selected.demand)).toBe(true);
  const duplicate = resources[32];
  assertResource(duplicate);
  duplicate.adopt({
    ...duplicate.snapshot,
    paramSnapshot: { ...duplicate.snapshot.paramSnapshot, subsurfaceWeight: 0 },
  });
  selected.adopt(frame.with(duplicate));
  expect(selected.demand).toBe(15);
});

function assertResource(value: MaterialResource | undefined): asserts value is MaterialResource {
  if (value === undefined) throw new Error('Missing material resource');
}

it('derives shared material demand from the accepted frame after live values advance', () => {
  const base = receiptRow().source;
  const resource = new MaterialResource({
    ...base.material.snapshot,
    deferredPass: true,
    surfaceModel: 'standard',
    paramSnapshot: { subsurfaceRadius: [6, 3, 1], subsurfaceWeight: 1 },
  });
  const accepted = new MaterialFrame(undefined).with(resource);
  const sources = Array.from({ length: 128 }, () => ({
    ...base,
    material: resource,
    materials: [resource],
  }));
  const selection = new SubsurfaceSelection();
  for (const source of sources) selection.add(source, accepted);
  selection.adopt(accepted);
  const oldDemand = selection.demand;
  resource.adopt({
    ...resource.snapshot,
    paramSnapshot: { subsurfaceRadius: [0, 0, 0], subsurfaceWeight: 0 },
  });
  const next = accepted.with(resource);
  const current = vi.spyOn(resource, 'snapshot', 'get').mockImplementation(() => {
    throw new Error('live material read');
  });
  const read = vi.spyOn(accepted, 'get');
  try {
    expect(subsurfaceDemand(oldDemand)).toBe(true);
    selection.adopt(next);
    expect(read).not.toHaveBeenCalled();
    expect(subsurfaceDemand(selection.demand)).toBe(false);
    expect(subsurfaceDemand(oldDemand)).toBe(true);
  } finally {
    current.mockRestore();
  }
});

it('keeps transparency dispatch indices in the original source domain and uses fixed values', () => {
  const base = receiptRow().source;
  const material = new MaterialResource({
    ...base.material.snapshot,
    materialHandle: 8,
    transparent: true,
  });
  const materialFrame = new MaterialFrame(undefined).with(material);
  const renderables = Array.from({ length: 8 }, () => ({
    ...base,
    material,
    materials: [material],
  }));
  material.adopt({ ...material.snapshot, transparent: false });
  const view = resolveTransparencyView({
    requested: 'sorted',
    rgba16floatRenderable: true,
    materialFrame,
    renderables,
    dispatch: [
      {
        entityIndex: 7,
        renderableIndex: 7,
        materialHandle: 8,
        passIndex: 0,
        queue: 3000,
        layer: 0,
        tags: { LightMode: 'Forward' },
        renderState: undefined,
        defines: undefined,
        vertexEntry: undefined,
        fragmentEntry: undefined,
        materialShaderId: 'forgeax::sprite',
      },
    ],
  });
  expect(view.inspection.sortedDrawCount).toBe(1);
});

it('maintains explicit hidden preparation membership at source changes and removes recycled slots', () => {
  const scene = new RenderScene();
  const base = receiptRow().source;
  const hidden = { ...base, entityKey: 1, authorVisible: false, pipelinePreparation: [] };
  scene.apply([
    { kind: 'update', worldId: 0, entityKey: 1, snapshot: hidden },
    { kind: 'update', worldId: 0, entityKey: 2, snapshot: { ...base, entityKey: 2 } },
  ]);
  const first = scene.slot(0, 1);
  if (first === undefined) throw new Error('Missing hidden source');
  expect([...scene.pipelinePreparationSlots]).toEqual([first.slot]);
  scene.apply([{ kind: 'update', worldId: 0, entityKey: 2, world: base.transform.world }]);
  expect([...scene.pipelinePreparationSlots]).toEqual([first.slot]);
  scene.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
  scene.apply([{ kind: 'update', worldId: 0, entityKey: 3, snapshot: { ...base, entityKey: 3 } }]);
  expect(scene.pipelinePreparationSlots.size).toBe(0);
  scene.reset([{ ...hidden, entityKey: 3 }]);
  expect([...scene.pipelinePreparationSlots]).toEqual([scene.slot(0, 3)?.slot]);
  scene.reset([{ ...base, entityKey: 3 }]);
  expect(scene.pipelinePreparationSlots.size).toBe(0);
});
