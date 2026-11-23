import type { box3 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { makeZeroCameraFallbackSnapshot } from '../../record/frame-snapshot';
import type { ExtractedFrame, RenderableSnapshot } from '../../render-system-extract';
import { MaterialFrame } from '../material-dispatch';
import { SceneDrawSlot } from '../mesh-draw';
import { cullPersistentFrame, type ViewCullStorage } from '../persistent-cull';
import type { RenderSceneSlot } from '../render-scene-types';
import { RenderScene } from '../render-scene-view';

it('tests moving scene slot bounds before projecting rejected draw and temporal rows', () => {
  const source = receiptRow().source;
  const materials = new MaterialFrame(undefined).with(source.material);
  const projection = new RenderScene();
  const memo: ViewCullStorage = { value: undefined };
  const pose = new Float32Array(source.transform.world);
  const count = 32;
  const localAabb = Float32Array.of(-0.1, -0.1, -8, 0.1, 0.1, -7);
  projection.apply(
    Array.from({ length: count }, (_, entityKey) => ({
      kind: 'update' as const,
      entityKey,
      snapshot: { ...source, entityKey, localAabb },
    })),
  );
  const draw = vi.spyOn(SceneDrawSlot.prototype, 'draw');
  const write = (row: RenderSceneSlot, out: box3.Box3) =>
    projection.writeCullingWorldBoundsAt(row, out);
  try {
    for (let tick = 1; tick <= 60; tick++) {
      const visible = tick % count;
      for (let entity = 0; entity < count; entity++) {
        pose[12] = entity === visible ? 0 : 100 + tick + entity;
        projection.apply([{ kind: 'update', entityKey: entity, world: pose }]);
      }
      const sequence = projection.materializeTemporal({ hits: 0, misses: 0 }, materials);
      const frame = {
        cameras: [makeZeroCameraFallbackSnapshot()],
        renderables: sequence,
        dispatch: [],
      } as unknown as ExtractedFrame;
      draw.mockClear();
      const result = cullPersistentFrame(
        frame,
        materials,
        undefined,
        memo,
        undefined,
        undefined,
        projection,
        0,
        undefined,
        write,
      ).frame;
      // Culling publishes slot addresses. Reading a requested visible row is the first pose consumer.
      expect(draw).not.toHaveBeenCalled();
      expect(result.renderables.map((row) => row.entityKey)).toEqual([visible]);
      expect(result.frustumStats).toMatchObject({ total: count, culled: count - 1 });
      expect(draw).toHaveBeenCalledTimes(1);
    }
  } finally {
    draw.mockRestore();
  }
});

it('honors the current frustum opt-out before testing a native slot on consecutive changes', () => {
  const source = receiptRow().source;
  const scene = new RenderScene();
  const materials = new MaterialFrame(undefined).with(source.material);
  const memo: ViewCullStorage = { value: undefined };
  const outside = Float32Array.of(100, -1, -10, 102, 1, -8);
  const bounds = vi.fn((row: RenderSceneSlot, out: box3.Box3) =>
    scene.writeCullingWorldBoundsAt(row, out),
  );
  for (let tick = 0; tick < 12; tick++) {
    const optOut = (tick & 1) === 0;
    const snapshot = {
      ...source,
      localAabb: outside,
      ...(optOut ? { frustumCulled: false as const } : {}),
    };
    scene.apply([{ kind: 'update', entityKey: source.entityKey, snapshot }]);
    const sequence = scene.materializeTemporal({ hits: 0, misses: 0 }, materials);
    const frame = {
      cameras: [makeZeroCameraFallbackSnapshot()],
      renderables: sequence,
      dispatch: [],
    } as unknown as ExtractedFrame;
    const result = cullPersistentFrame(
      frame,
      materials,
      undefined,
      memo,
      undefined,
      undefined,
      scene,
      0,
      undefined,
      bounds,
    );
    expect(result.frame.renderables.length).toBe(optOut ? 1 : 0);
    expect(bounds).toHaveBeenCalledTimes(optOut ? 0 : 1);
    bounds.mockClear();
  }
});

it('keeps visible native draws when a sibling of the same entity is outside the camera', () => {
  const source = receiptRow().source;
  const visible: RenderableSnapshot = {
    ...source,
    nativeDraw: { key: 'water-near' },
    localAabb: Float32Array.of(-1, -1, -10, 1, 1, -8),
  };
  const outside: RenderableSnapshot = {
    ...source,
    nativeDraw: { key: 'water-far' },
    localAabb: Float32Array.of(100, -1, -10, 102, 1, -8),
  };
  const frame = {
    cameras: [makeZeroCameraFallbackSnapshot()],
    renderables: [visible, outside],
    dispatch: [],
  } as unknown as ExtractedFrame;

  const result = cullPersistentFrame(
    frame,
    new MaterialFrame(undefined).with(source.material),
  ).frame;

  expect(result.renderables).toEqual([visible]);
  expect(result.frustumStats).toMatchObject({ culled: 1, total: 2 });
  expect(result.cameraVisible?.(visible)).toBe(true);
  expect(result.cameraVisible?.(outside)).toBe(false);
});

it('shares equal material selections across moving rows and splits at actual exclusions', () => {
  const source = receiptRow().source;
  const materials = new MaterialFrame(undefined).with(source.material);
  const memo: ViewCullStorage = { value: undefined };
  const visible = { ...source, localAabb: Float32Array.of(-1, -1, -10, 1, 1, -8) };
  const run = (rows: RenderableSnapshot[]) => {
    const frame = {
      cameras: [makeZeroCameraFallbackSnapshot()],
      renderables: rows,
      dispatch: [],
    } as unknown as ExtractedFrame;
    cullPersistentFrame(frame, materials, undefined, memo);
    return memo.value;
  };
  const all = run([visible, { ...visible, entityKey: source.entityKey + 1 }]);
  expect(all?.authorSubsurface).toBe(all?.sourceSubsurface);
  expect(all?.admittedSubsurface).toBe(all?.authorSubsurface);
  const hidden = run([
    visible,
    { ...visible, entityKey: source.entityKey + 1, authorVisible: false },
  ]);
  expect(hidden?.sourceSubsurface).not.toBe(hidden?.authorSubsurface);
  expect(hidden?.admittedSubsurface).toBe(hidden?.authorSubsurface);
  const clipped = run([
    visible,
    {
      ...visible,
      entityKey: source.entityKey + 1,
      localAabb: Float32Array.of(100, -1, -10, 102, 1, -8),
    },
  ]);
  expect(clipped?.sourceSubsurface).toBe(clipped?.authorSubsurface);
  expect(clipped?.admittedSubsurface).not.toBe(clipped?.authorSubsurface);
  expect(clipped?.renderables).toEqual([visible]);
});
