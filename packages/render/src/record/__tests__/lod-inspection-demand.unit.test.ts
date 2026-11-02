import { assert, expect, it, vi } from 'vitest';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { ExtractedFrame, RenderableSnapshot } from '../../render-system-extract';
import { setSceneRow } from '../../scene/__tests__/scene-row-writes';
import { FrameProjection, RetainedFrameProjection } from '../../scene/frame-list';
import type { PersistentRenderScene } from '../../scene/render-scene';
import type { RenderSceneSlot } from '../../scene/render-scene-types';
import { SceneSlots } from '../../scene/scene-slots';
import * as cpuLod from '../cpu-lod';
import { makeZeroCameraFallbackSnapshot } from '../frame-snapshot';
import { LodInspectionOwner } from '../lod-inspection';
import type { RenderSystemInternals } from '../render-context';

function fixture(count = 4096, gpu = true) {
  const slots = new SceneSlots();
  for (let index = 0; index < count; index++) {
    setSceneRow(slots, index, {
      slot: index,
      generation: 0,
      version: 0,
      worldId: 0,
      entityKey: index,
      snapshot: {
        worldId: 0,
        entityKey: index,
        assetHandle: 1,
        ...(index === count - 1 ? { lods: [{}, {}, {}] } : {}),
      } as unknown as RenderableSnapshot,
    });
  }
  const root = slots.capture();
  const project = vi.fn((slot: RenderSceneSlot) => slot.snapshot);
  const renderables = new RetainedFrameProjection(root, project, {
    lodCandidateCount: slots.lodCandidateCount,
    *sparseRows() {},
  });
  const scene = {
    compositionSlots: vi.fn(() => root),
    compositionSlot: vi.fn((worldId: number, entityKey: number) => root.lookup(worldId, entityKey)),
    topologyRevision: () => 1,
  };
  const internals = {
    device: { caps: { compute: gpu, storageBuffer: gpu, indirectDrawing: gpu } },
    gpuStore: { getMeshGpuHandles: () => undefined },
    deviceScope: { generation: 1 },
    build: 'fixed-build',
  } as unknown as RenderSystemInternals;
  const owner = new LodInspectionOwner(internals, scene as unknown as PersistentRenderScene);
  const camera = { ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: 9 };
  const scopes = [{ identity: 'world-a' }] as unknown as RenderResourceScope[];
  const frame = { renderables, frustumStats: { culled: 0 } } as unknown as ExtractedFrame;
  const visibility = { worldKeys: [17], projection: { renderables } };
  return { slots, root, project, renderables, scene, owner, camera, scopes, frame, visibility };
}

it('does not sample a sparse-LOD owned roster before an explicit inspection', () => {
  const f = fixture();
  expect(f.owner.inspectFrame(f.camera, f.frame, f.visibility, f.scopes, 0, 1)).toBe(1);
  expect(f.project).not.toHaveBeenCalled();
  expect(f.scene.compositionSlot).not.toHaveBeenCalled();
  const inspection = f.owner.cell?.value();
  expect(f.project).toHaveBeenCalled();
  expect(inspection?.worlds[0]?.rows[0]?.slot).toEqual({ primitiveSlot: 4095, slotGeneration: 0 });
});

it('keeps lazy samples on their captured root after deletion and address reuse', () => {
  const f = fixture(8);
  f.owner.inspectFrame(f.camera, f.frame, f.visibility, f.scopes, 0, 1);
  const held = f.owner.cell;
  assert(held);
  f.slots.remove(7);
  setSceneRow(f.slots, 7, {
    slot: 7,
    generation: 1,
    version: 0,
    worldId: 0,
    entityKey: 900,
    snapshot: {
      worldId: 0,
      entityKey: 900,
      assetHandle: 1,
      lods: [{}],
    } as unknown as RenderableSnapshot,
  });
  const next = f.slots.capture();
  expect(next.lookup(0, 7)).toBeUndefined();
  expect(next.lookup(0, 900)?.generation).toBe(1);
  expect(held.value().worlds[0]?.rows[0]?.slot).toEqual({ primitiveSlot: 7, slotGeneration: 0 });
});

it('keeps custom projections on ordinary capture-time sampling', () => {
  const f = fixture(8);
  const renderables = new FrameProjection(f.renderables, (row) => row);
  f.owner.inspectFrame(
    f.camera,
    { ...f.frame, renderables },
    { ...f.visibility, projection: { renderables } },
    f.scopes,
    0,
    1,
  );
  expect(f.project).toHaveBeenCalled();
  expect(f.scene.compositionSlot).toHaveBeenCalled();
  expect(f.owner.cell?.value().worlds[0]?.rows[0]?.slot.primitiveSlot).toBe(7);
});

it('counts current borrowed rows when the same list changes its LOD membership', () => {
  const f = fixture(8);
  const renderables = [...f.renderables];
  const frame = { ...f.frame, renderables };
  const visibility = { ...f.visibility, projection: { renderables } };
  expect(f.owner.inspectFrame(f.camera, frame, visibility, f.scopes, 0, 1)).toBe(1);
  const last = renderables[7];
  assert(last);
  const { lods: _lods, ...plain } = last;
  renderables[7] = plain;
  expect(f.owner.inspectFrame(f.camera, frame, visibility, f.scopes, 0, 2)).toBe(0);
});

it('does not infer an arbitrary custom mapping LOD count from its source', () => {
  const f = fixture(8);
  const renderables = new FrameProjection(f.renderables, (row) => {
    const { lods: _lods, ...plain } = row;
    return plain;
  });
  expect(
    f.owner.inspectFrame(
      f.camera,
      { ...f.frame, renderables },
      { ...f.visibility, projection: { renderables } },
      f.scopes,
      0,
      1,
    ),
  ).toBe(0);
});

it('does not reuse an old filtered borrowed population with the same candidate count', () => {
  const level = vi
    .spyOn(cpuLod, 'cpuLodLevel')
    .mockImplementation((row) => (row.entityKey === 0 ? 2 : 1));
  try {
    const f = fixture(8, false);
    const renderables = [...f.renderables];
    const frame = { ...f.frame, renderables };
    const visibility = { ...f.visibility, projection: { renderables } };
    f.owner.inspectFrame(f.camera, frame, visibility, f.scopes, 0, 1);
    expect(f.owner.cell?.value().lodHistogram).toEqual([{ level: 1, count: 1 }]);
    const last = renderables[7],
      first = renderables[0];
    assert(last && first);
    const { lods, ...plain } = last;
    assert(lods);
    renderables[7] = plain;
    renderables[0] = { ...first, lods };
    f.owner.inspectFrame(f.camera, frame, visibility, f.scopes, 0, 2);
    expect(f.owner.cell?.value().lodHistogram).toEqual([{ level: 2, count: 1 }]);
  } finally {
    level.mockRestore();
  }
});
