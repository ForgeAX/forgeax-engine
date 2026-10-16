import { expect, it } from 'vitest';
import type {
  GpuDrivenDrawSnapshot,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../../render-system-extract';
import { RenderScene } from '../../scene/render-scene';
import { projectVisibleSurfaces, resolveVisibleSurface } from '../visible-surface';

const materials = [
  { materialHandle: 7 } as MaterialSnapshot,
  { materialHandle: 11 } as MaterialSnapshot,
] as const;
const triangleDraw: GpuDrivenDrawSnapshot = {
  kind: 'indexed',
  first: 9,
  count: 6,
  baseVertex: -2,
  materialSlot: 1,
  topology: 'triangle-list',
  pipelineClass: 'standard',
  materialResourceClass: '',
};
function snapshot(entityKey: number, generations?: readonly number[]): RenderableSnapshot {
  return {
    worldId: 0,
    entityKey,
    assetHandle: 91,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    material: materials[0],
    materials,
    materialBindingSources: ['mesh-default', 'mesh-default'],
    // Draw one was filtered out, so the next source submesh must remain two.
    gpuDrivenDraws: [
      { ...triangleDraw, drawItemIndex: 0 },
      { ...triangleDraw, drawItemIndex: 2, first: 30, materialSlot: 0 },
    ],
    ...(generations === undefined
      ? {}
      : {
          instances: {
            transforms: new Float32Array(generations.length * 16),
            generations: Uint32Array.from(generations),
            instanceCount: generations.length,
            cacheKey: entityKey,
            archVersion: 0,
          },
        }),
  };
}
function update(source: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: source.worldId,
    entityKey: source.entityKey,
    snapshot: source,
  };
}

it('preserves submesh holes, material slots, instance identity and draw-local primitive offsets', () => {
  const scene = new RenderScene();
  scene.apply([update(snapshot(17, [501, 902]))]);
  const frame = projectVisibleSurfaces(scene.slotsSnapshot(), 6).unwrap();
  expect(resolveVisibleSurface(frame, 0, 0).unwrap()).toBeUndefined();
  expect(resolveVisibleSurface(frame, 2, 1).unwrap()).toMatchObject({
    entityKey: 17,
    instanceOrdinal: 1,
    instanceGeneration: 902,
    drawItemIndex: 0,
    materialHandle: 11,
    assetHandle: 91,
    firstElement: 12,
    baseVertex: -2,
    indexed: true,
  });
  expect(resolveVisibleSurface(frame, 5, 0).unwrap()).toMatchObject({
    drawItemIndex: 2,
    instanceGeneration: 501,
    materialHandle: 7,
    firstElement: 30,
  });
  expect(resolveVisibleSurface(frame, 3, 0).ok).toBe(false);
  expect(resolveVisibleSurface(frame, 2, 2).ok).toBe(false);
  expect(resolveVisibleSurface(frame, 7, 0).ok).toBe(false);
});

it('keeps submitted rows detached across instance reorder, deletion and RenderScene slot reuse', () => {
  const scene = new RenderScene();
  scene.apply([update(snapshot(17, [501, 902]))]);
  const first = projectVisibleSurfaces(scene.slotsSnapshot(), 6).unwrap();
  scene.apply([update(snapshot(17, [902, 501]))]);
  const reordered = projectVisibleSurfaces(scene.slotsSnapshot(), 6).unwrap();
  expect(resolveVisibleSurface(first, 1, 0).unwrap()?.instanceGeneration).toBe(501);
  expect(resolveVisibleSurface(reordered, 1, 0).unwrap()?.instanceGeneration).toBe(902);
  scene.apply([{ kind: 'remove', worldId: 0, entityKey: 17 }]);
  expect(projectVisibleSurfaces(scene.slotsSnapshot(), 0).unwrap().records.byteLength).toBe(0);
  scene.apply([update(snapshot(18, [501, 902]))]);
  const replaced = projectVisibleSurfaces(scene.slotsSnapshot(), 6).unwrap();
  const prior = resolveVisibleSurface(first, 1, 0).unwrap();
  const current = resolveVisibleSurface(replaced, 1, 0).unwrap();
  if (prior === undefined || current === undefined) throw new Error('missing retained row');
  expect(current.slot).toBe(prior.slot);
  expect(current.generation).not.toBe(prior.generation);
  expect(prior.entityKey).toBe(17);
  expect(current.entityKey).toBe(18);
});

it('does not let source ordering change retained scene addresses', () => {
  const scene = new RenderScene();
  scene.apply([update(snapshot(17)), update(snapshot(19))]);
  const slots = scene.slotsSnapshot();
  expect(projectVisibleSurfaces(slots, 6).unwrap().records).toEqual(
    projectVisibleSurfaces([...slots].reverse(), 6).unwrap().records,
  );
});

it('rejects incomplete budgets and unproved instance identity without publishing partial rows', () => {
  const scene = new RenderScene();
  scene.apply([update(snapshot(17, [501, 902]))]);
  expect(projectVisibleSurfaces(scene.slotsSnapshot(), 5).ok).toBe(false);
  scene.apply([update(snapshot(17, [501, 501]))]);
  expect(projectVisibleSurfaces(scene.slotsSnapshot(), 6).ok).toBe(false);
  scene.apply([update(snapshot(17, [0, 902]))]);
  expect(projectVisibleSurfaces(scene.slotsSnapshot(), 6).ok).toBe(false);
});

it('resolves non-indexed triangle starts and rejects malformed source ranges', () => {
  const scene = new RenderScene();
  const source = {
    ...snapshot(17),
    gpuDrivenDraws: [{ ...triangleDraw, kind: 'non-indexed' as const, baseVertex: 0 }],
  };
  scene.apply([update(source)]);
  expect(
    resolveVisibleSurface(projectVisibleSurfaces(scene.slotsSnapshot(), 1).unwrap(), 1, 1).unwrap(),
  ).toMatchObject({ indexed: false, firstElement: 12 });
  for (const count of [-3, 4, Number.NaN]) {
    scene.apply([
      update({
        ...source,
        gpuDrivenDraws: [{ ...triangleDraw, kind: 'non-indexed' as const, baseVertex: 0, count }],
      }),
    ]);
    expect(projectVisibleSurfaces(scene.slotsSnapshot(), 1).ok).toBe(false);
  }
});

it('publishes no rows for deformed or LOD draws so their pixels read as uncovered', () => {
  const scene = new RenderScene();
  const skinned = { ...snapshot(19), skin: {} } as RenderableSnapshot;
  scene.apply([update(snapshot(17)), update(skinned)]);
  const frame = projectVisibleSurfaces(scene.slotsSnapshot(), 3).unwrap();
  expect(frame.entityBases.has(19)).toBe(false);
  expect(frame.records.length).toBe(3 * 16);
  expect(resolveVisibleSurface(frame, 1, 0).unwrap()?.entityKey).toBe(17);
});
