import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { MeshBatchProjection } from '../gpu-driven/mesh-batches';
import { MaterialResource } from '../material-resource';
import { MeshFrame } from '../scene/mesh-frame';
import { captureMaterialOverrides, prepareMeshMaterialBindings } from '../scene/mesh-materials';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';

it.each([
  64, 1024,
])('publishes %i shared Mesh groups without executing a resource join', (count) => {
  const original = receiptRow().source;
  const rows = Array.from({ length: count }, (_, index) => {
    const material = new MaterialResource(original.material.snapshot);
    return {
      ...original,
      entityKey: index + 1,
      material,
      materials: [material],
      materialOverrides: Object.freeze([material]),
      materialBindingSources: ['renderer-override'] as const,
    };
  });
  const scene = new RenderScene();
  scene.reset(rows);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const windows = new MeshBatchProjection();
  const actualQuery = vi.spyOn(windows, 'query');
  const mesh = createPrimitiveMesh('cube').unwrap();
  const accepted = new MeshFrame().with(original.worldId, original.assetHandle as number, mesh);
  const edited = accepted.with(original.worldId, original.assetHandle as number, {
    ...mesh,
    aabb: new Float32Array([-2, -2, -2, 2, 2, 2]),
  });
  const reads = vi.spyOn(edited, 'get');
  const source = topology.sourcePlan();
  expect(source.batches.length).toBe(count);
  expect(source.visibleCapacity).toBe(0); // Publication owns no physical output window.
  expect(topology.sourcePlan()).toBe(source);
  expect(actualQuery).not.toHaveBeenCalled();
  expect(reads).not.toHaveBeenCalled();
  const before = windows.query(source, edited);
  expect(reads).toHaveBeenCalledTimes(count); // Explicit actual task preparation, not publication.
  const survivor = before.batches.at(-1);
  const queriedReads = reads.mock.calls.length;
  expect(windows.query(source, edited)).toBe(before);
  expect(reads).toHaveBeenCalledTimes(queriedReads);
  topology.apply(scene.apply([{ kind: 'remove', worldId: original.worldId, entityKey: 1 }]));
  const removed = topology.sourcePlan();
  expect(actualQuery).toHaveBeenCalledTimes(2);
  expect(reads).toHaveBeenCalledTimes(queriedReads);
  const after = windows.query(removed, edited);
  expect(after.batches.at(-1)).toBe(survivor);
  expect(after.candidateCount).toBe(count - 1);
  expect(windows.windowRelocations).toBe(0);
  expect(windows.windowCompactions).toBe(0);
  windows.reset();
});

it('uses the accepted Mesh material query for execution after a default-slot edit', () => {
  const original = receiptRow().source;
  const medium = new MaterialResource({
    ...original.material.snapshot,
    materialHandle: 105,
    surfaceModel: 'single-layer-medium',
  });
  const scene = new RenderScene();
  scene.reset([{ ...original, materialOverrides: captureMaterialOverrides([]) }]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const source = topology.sourcePlan();
  const mesh = createPrimitiveMesh('cube').unwrap();
  const before = new MeshFrame().with(original.worldId, original.assetHandle as number, mesh);
  const windows = new MeshBatchProjection();
  const previous = windows.query(source, before);
  const edited = before.with(original.worldId, original.assetHandle as number, {
    ...mesh,
    materialSlots: [{ slotName: 'surface', defaultMaterial: 105 as never }],
  });
  const geometry = edited.get(original.worldId, original.assetHandle);
  const slot = scene.slotsSnapshot().at(0);
  if (geometry === undefined || slot === undefined) throw new Error('missing accepted mesh');
  const pending: Parameters<typeof prepareMeshMaterialBindings>[4] = [];
  const accepted = prepareMeshMaterialBindings(
    slot.snapshot,
    geometry,
    'mesh',
    () => medium,
    pending,
  );
  for (const write of pending) write.contexts.set(write.geometry, write.value);
  const current = windows.query(source, edited);
  expect(accepted.material).toBe(medium);
  expect(current.batches.at(0)?.binding?.material).toBe(accepted.material);
  expect(current.batches.at(0)?.members).toBe(previous.batches.at(0)?.members);
  expect(current.batches.at(0)?.candidates).toBe(previous.batches.at(0)?.candidates);
  expect(previous.batches.at(0)?.binding?.material).not.toBe(medium);
});

it('captures a canonical override table without retaining a caller-mutable array', () => {
  const original = receiptRow().source;
  const overrides = [original.material];
  const scene = new RenderScene();
  scene.reset([{ ...original, materialOverrides: overrides }]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const captured = topology.sourcePlan().batches.at(0)?.binding?.source?.materialOverrides;
  expect(captured).toBe(captureMaterialOverrides(overrides));
  expect(Object.isFrozen(captured)).toBe(true);
  overrides.length = 0;
  expect(captured).toEqual([original.material]);
});
