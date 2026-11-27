import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { box3 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { captureMaterialSnapshot, MaterialResource } from '../../material-resource';
import { makeZeroCameraFallbackSnapshot } from '../../record/frame-snapshot';
import type { ExtractedFrame, RenderableSnapshot } from '../../render-system-extract';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import * as displacement from '../../standard-displacement-bounds';
import { MaterialFrame } from '../material-dispatch';
import { SceneDrawSlot } from '../mesh-draw';
import { MeshFrame } from '../mesh-frame';
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
    const admission = result.frame.cameraAdmission;
    expect(admission).toBeDefined();
    expect(admission?.hidden.size).toBe(optOut ? 0 : 1);
    expect(result.frame.cameraVisible?.(snapshot)).toBe(optOut);
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
  expect(clipped?.admittedSubsurface).toBe(clipped?.authorSubsurface);
  expect(clipped?.renderables).toEqual([visible]);
});

it('selects active subsurface profiles through material edits with fixed and changing visibility', () => {
  const source = receiptRow().source;
  const material = () =>
    new MaterialResource({
      ...source.material.snapshot,
      surfaceModel: 'standard',
      deferredPass: true,
      paramSnapshot: { subsurfaceWeight: 0, subsurfaceRadius: [2, 1, 1] },
    });
  const near = material(),
    far = material();
  let materials = new MaterialFrame(undefined).with(near).with(far);
  const memo: ViewCullStorage = { value: undefined };
  const visible = Float32Array.of(-1, -1, -10, 1, 1, -8);
  const hidden = Float32Array.of(100, -1, -10, 102, 1, -8);
  const rows = [near, far].map((binding, entityKey) => ({
    ...source,
    entityKey,
    material: binding,
    materials: [binding],
    localAabb: entityKey ? hidden : visible,
  }));
  const frame = {
    cameras: [makeZeroCameraFallbackSnapshot()],
    renderables: rows,
    dispatch: [],
  } as unknown as ExtractedFrame;
  const read = () => cullPersistentFrame(frame, materials, undefined, memo).subsurface;
  const edit = (resource: MaterialResource, weight: number) => {
    resource.adopt({
      ...resource.snapshot,
      paramSnapshot: { ...resource.snapshot.paramSnapshot, subsurfaceWeight: weight },
    });
    materials = materials.with(resource);
  };
  expect(read()).toEqual({ source: 0, authorVisible: 0, admitted: 0 });
  edit(far, 1);
  expect(read()).toEqual({
    source: expect.any(Array),
    authorVisible: expect.any(Array),
    admitted: 0,
  });
  edit(near, 1);
  expect(read().admitted).toHaveLength(1);
  edit(far, 0);
  for (const row of rows) row.localAabb = row.material === near ? hidden : visible;
  expect(read().admitted).toBe(0);
  edit(near, 0);
  expect(read().source).toBe(0);
  edit(far, 2);
  expect(read().admitted).toBe('invalid-values');
});

it('keeps the radius of a moving row across roughness publications and rebinds displacement', () => {
  const scene = new RenderScene();
  const base = captureMaterialSnapshot(defaultMaterialSnapshot(41));
  const meshes = new MeshFrame().with(9, createBoxGeometry(2, 2, 2).unwrap());
  const material = new MaterialResource(base);
  const other = new MaterialResource(captureMaterialSnapshot(defaultMaterialSnapshot(42)));
  let frame = new MaterialFrame(undefined).with(material).with(other);
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const snapshot = {
    ...receiptRow().source,
    entityKey: 1,
    material,
    materials: [material],
    localAabb: Float32Array.of(-1, -1, -1, 1, 1, 1),
    transform: { world: pose },
  };
  scene.apply([{ kind: 'update', entityKey: 1, snapshot }]);
  const first = scene.slot(1);
  if (!first) throw Error('missing moving row');
  const start = frame;
  expect(scene.cullingWorldBoundsAt(first, meshes, frame)?.max[0]).toBe(1);
  const read = vi.spyOn(displacement, 'materialDisplacementRadius');
  let radiusReads = 0;
  try {
    for (let tick = 1; tick <= 30; tick++) {
      material.adopt(captureMaterialSnapshot({ ...base, roughness: tick / 31 }));
      const next = frame.with(material);
      next.publishChangesSince(frame);
      frame = next;
      pose[12] = tick;
      scene.apply([{ kind: 'update', entityKey: 1, world: pose }]);
      const row = scene.slot(1);
      if (!row) throw Error('missing moved row');
      read.mockClear();
      expect(scene.cullingWorldBoundsAt(row, meshes, frame)?.max[0]).toBe(tick + 1);
      radiusReads += read.mock.calls.length;
    }
    expect(radiusReads).toBe(0);
    const finalRow = scene.slot(1);
    if (!finalRow) throw Error('missing final row');
    material.adopt(
      captureMaterialSnapshot({
        ...base,
        materialParamSchema: [{ name: 'displacementTexture', type: 'texture2d' }],
        standardTextureMask: undefined,
        paramSnapshot: { displacementScale: 2 },
      }),
    );
    const expanded = frame.with(material);
    expanded.publishChangesSince(frame);
    expect(scene.cullingWorldBoundsAt(finalRow, meshes, expanded)?.max[0]).toBe(33);
    expect(scene.cullingWorldBoundsAt(finalRow, meshes, frame)?.max[0]).toBe(31);
    expect(scene.cullingWorldBoundsAt(first, meshes, start)?.max[0]).toBe(1);
    scene.apply([
      {
        kind: 'update',
        entityKey: 1,
        snapshot: { ...snapshot, material: other, materials: [other] },
      },
    ]);
    const rebound = scene.slot(1);
    if (!rebound) throw Error('missing rebound row');
    expect(scene.cullingWorldBoundsAt(rebound, meshes, expanded)?.max[0]).toBe(31);
    expect(scene.cullingWorldBoundsAt(finalRow, meshes, expanded)?.max[0]).toBe(33);
    const removed = expanded.without(material);
    removed.publishChangesSince(expanded);
    expect(() => scene.cullingWorldBoundsAt(finalRow, meshes, removed)).toThrow(
      'fixed material version',
    );
  } finally {
    read.mockRestore();
  }
});

it('publishes changing camera membership and dense dispatch ranks across physical slot holes', () => {
  const source = receiptRow().source;
  const scene = new RenderScene();
  const material = new MaterialFrame(undefined).with(source.material);
  const memo: ViewCullStorage = { value: undefined };
  const keys = Array.from({ length: 1040 }, (_, key) => key);
  scene.apply(
    keys.map((entityKey) => ({ kind: 'update', entityKey, snapshot: { ...source, entityKey } })),
  );
  const remove = (key: number) => key % 13 === 2 || (key >= 128 && key < 512);
  scene.apply(keys.filter(remove).map((entityKey) => ({ kind: 'remove', entityKey })));
  const live = keys.filter((key) => !remove(key));
  const dispatch = live.map((entityIndex, renderableIndex) => ({
    entityIndex,
    renderableIndex,
    tags: { LightMode: 'Forward' },
  }));
  const sequence = scene.materializeTemporal({ hits: 0, misses: 0 }, material);
  const frame = {
    cameras: [makeZeroCameraFallbackSnapshot()],
    renderables: sequence,
    dispatch,
  } as unknown as ExtractedFrame;
  let first: ExtractedFrame | undefined;
  let firstKeys: number[] = [];
  for (let tick = 0; tick < 6; tick++) {
    const inside = (key: number) => (key + tick) % 7 < 3;
    const expected = live.filter(inside);
    const result = cullPersistentFrame(
      frame,
      material,
      undefined,
      memo,
      undefined,
      undefined,
      scene,
      0,
      undefined,
      (row, out) => {
        const x = inside(row.entityKey) ? 0 : 100;
        out.set([x, -0.1, -8, x + 0.1, 0.1, -7]);
        return true;
      },
    ).frame;
    expect(result.renderables.map((row) => row.entityKey)).toEqual(expected);
    expect(
      Array.from(result.dispatch, (entry) => [entry.entityIndex, entry.renderableIndex]),
    ).toEqual(expected.map((key, rank) => [key, rank]));
    expect(Array.from(result.cameraAdmission?.hidden ?? [])).toEqual(
      live.filter((key) => !inside(key)),
    );
    if (!first) {
      first = result;
      firstKeys = expected;
    }
  }
  expect(first?.renderables.map((row) => row.entityKey)).toEqual(firstKeys);
  expect(first?.cameraAdmission?.hidden.has(31)).toBe(true);
});
