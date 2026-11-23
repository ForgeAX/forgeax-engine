import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { AssetHandle, TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { captureMaterialSnapshot, MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { createFoldedDrawRecorder } from '../record/fold-instance-buffer';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { FoldBucket } from '../record/mesh-ssbo';
import type { RenderSystemInternals } from '../record/render-context';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import {
  createPresentationDraws,
  markPipelinePreparationPending,
  missingDrawEvidence,
  projectDisplayRenderables,
  projectFramePresentation,
} from '../render-system-presentation';
import { MaterialFrame } from '../scene/material-dispatch';
import { RenderScene } from '../scene/render-scene-view';
import { RowViews, SceneSlotFrame } from '../scene/scene-slots';

it('keeps concrete submitted submeshes independent of entity and terrain evidence', () => {
  const draws = createPresentationDraws();
  draws.record(42, undefined, 7);
  expect(draws.hasEntity(42)).toBe(true);
  expect(draws.hasSubmesh(42, 0)).toBe(false);
  expect(draws.hasTerrain(42, 7)).toBe(false);
  draws.record(42, 0, 7);
  draws.record(42, 0, 7);
  draws.record(42, undefined);
  draws.record(42, 9, 8);
  expect([0, 1, 9].map((index) => draws.hasSubmesh(42, index))).toEqual([true, false, true]);
  expect([7, 8, 9].map((index) => draws.hasTerrain(42, index))).toEqual([true, true, false]);
  expect(draws.hasEntity(43)).toBe(false);
  expect(createPresentationDraws().hasEntity(42)).toBe(false);
});

it('does not borrow same-numbered draws across stable Worlds or confuse numeric indices', () => {
  const draws = createPresentationDraws();
  const first = 17 * 4294967296 + 42;
  const second = 18 * 4294967296 + 42;
  draws.record(first, 0);
  draws.record(first, 65536);
  draws.record(second, 7, 0);
  expect(draws.hasSubmesh(first, 7)).toBe(false);
  expect(draws.hasSubmesh(second, 0)).toBe(false);
  expect(draws.hasSubmesh(first, 65536)).toBe(true);
  expect(draws.hasTerrain(first, 0)).toBe(false);
  expect(draws.hasTerrain(second, 0)).toBe(true);
});
it('keeps primary draw bits across page revisits and independent recording attempts', () => {
  const a = createPresentationDraws();
  const b = createPresentationDraws();
  const high = 18 * 2 ** 32;
  for (const entity of [0, high + 31, 32, high + 32, 31, high, 63, high + 63]) a.record(entity, 0);
  a.record(1, undefined);
  a.record(high + 1, 4, 9);
  b.record(1, 0);
  for (const entity of [0, 31, 32, 63, high, high + 31, high + 32, high + 63]) {
    expect(a.hasSubmesh(entity, 0)).toBe(true);
    expect(b.hasEntity(entity)).toBe(false);
  }
  for (const entity of [1, high + 1]) {
    expect(a.hasEntity(entity)).toBe(true);
    expect(a.hasSubmesh(entity, 0)).toBe(false);
  }
  expect(a.hasTerrain(high + 1, 9)).toBe(true);
  expect(b.hasSubmesh(1, 0)).toBe(true);
});

const missingAssetSource = new World();
function projectSubmittedWorkset(input: {
  hasCamera: boolean;
  hasEnvironment: boolean;
  environmentReady: boolean;
  submissionRenderables: readonly RenderableSnapshot[];
  submissionDispatch: readonly DispatchEntry[];
  preparedSource: World | undefined;
  internals: RenderSystemInternals;
}) {
  const renderables = input.hasCamera
    ? projectDisplayRenderables(input.submissionRenderables, input.submissionDispatch)
    : [];
  const presentation = input.hasCamera
    ? !input.hasEnvironment || !input.environmentReady
      ? 'pending'
      : projectFramePresentation({
          renderables,
          preparedSourceScope: worldRenderResources(input.preparedSource ?? missingAssetSource),
          internals: input.internals,
        })
    : 'ready';
  return { renderables, presentation };
}

it.each([
  'instances',
  'spriteInstances',
] as const)('excludes empty %s from presentation and resumes gating when populated', (field) => {
  const project = (count: number | undefined, hasCamera = true) =>
    projectSubmittedWorkset({
      hasCamera,
      hasEnvironment: true,
      environmentReady: true,
      submissionRenderables: [
        {
          authorVisible: true,
          assetHandle: 0,
          entityKey: 1,
          transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
          material: MaterialResource.from({
            ...defaultMaterialSnapshot(),
            videoTextureFields: new Map([['baseColor', 'missing-clip' as never]]),
          }),
          materials: [
            MaterialResource.from({
              ...defaultMaterialSnapshot(),
              videoTextureFields: new Map([['baseColor', 'missing-clip' as never]]),
            }),
          ],
          materialBindingSources: [],
          ...(count === undefined
            ? {}
            : {
                [field]: {
                  instanceCount: count,
                  transforms: new Float32Array(count * 16),
                  ...(field === 'spriteInstances' ? { regions: new Float32Array(count * 4) } : {}),
                  cacheKey: 1,
                  archVersion: 0,
                },
              }),
        } satisfies RenderableSnapshot,
      ],
      submissionDispatch: [
        {
          entityIndex: 0,
          materialHandle: 0,
          renderableIndex: 0,
          passIndex: 0,
          queue: 2000,
          layer: 0,
          tags: { LightMode: 'Forward' },
          renderState: undefined,
          defines: undefined,
          vertexEntry: undefined,
          fragmentEntry: undefined,
          materialShaderId: undefined,
        } satisfies DispatchEntry,
      ],
      // Missing producer data gates populated work; an empty collection draws nothing.
      preparedSource: undefined,
      internals: {} as RenderSystemInternals,
    });
  expect(project(0)).toEqual({ renderables: [], presentation: 'ready' });
  expect(project(1).presentation).toBe('pending');
  expect(project(0)).toEqual({ renderables: [], presentation: 'ready' });
  expect(project(undefined).presentation).toBe('pending');
  expect(project(1, false)).toEqual({ renderables: [], presentation: 'ready' });
});

it('checks a shared visible material once and observes video readiness again next frame', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const material = MaterialResource.from({
    ...defaultMaterialSnapshot(),
    videoTextureFields: new Map([['clip', Number(1) as AssetHandle<'video'>]]),
  });
  const getView = vi.fn(() => ({}) as unknown);
  const renderables = Array.from(
    { length: 2048 },
    (_, entityKey) =>
      ({
        entityKey,
        assetHandle: 0,
        authorVisible: true,
        transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
        material,
        materials: [material],
        materialBindingSources: [],
      }) satisfies RenderableSnapshot,
  );
  const dispatch = renderables.map(
    (_, renderableIndex) =>
      ({
        entityIndex: renderableIndex,
        renderableIndex,
        materialHandle: 0,
        passIndex: 0,
        queue: 2000,
        layer: 0,
        tags: { LightMode: 'Forward' },
        renderState: undefined,
        defines: undefined,
        vertexEntry: undefined,
        fragmentEntry: undefined,
        materialShaderId: undefined,
      }) satisfies DispatchEntry,
  );
  const project = () =>
    projectSubmittedWorkset({
      hasCamera: true,
      hasEnvironment: true,
      environmentReady: true,
      submissionRenderables: renderables,
      submissionDispatch: dispatch,
      preparedSource: world,
      internals: { dynamicTextureStore: { getView } } as unknown as RenderSystemInternals,
    });
  expect(project().presentation).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(1);
  getView.mockReturnValue(undefined);
  expect(project().presentation).toBe('pending');
  expect(getView).toHaveBeenCalledTimes(2);
});

it('observes a shared material once per scope and refreshes the next presentation', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const gpuStore = new GpuResidencyCache();
  gpuStore.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const texture: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'packed', levelCount: 1 },
    data: new Uint8Array(64),
  };
  const handles = [assets.create(texture).unwrap(), assets.create(texture).unwrap()] as const;
  expect(handles[0]).not.toBe(handles[1]);
  const materials = handles.map((handle) =>
    MaterialResource.from({
      ...defaultMaterialSnapshot(),
      baseColorTexture: handle,
    }),
  );
  const rows = Array.from({ length: 200 }, (_, index): RenderableSnapshot => {
    const material = materials[index % 2];
    if (material === undefined) throw new Error('expected a World material');
    return {
      authorVisible: true,
      assetHandle: 0,
      entityKey: index + 1,
      transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
      material,
      materials: [material],
      materialBindingSources: [],
    };
  });
  const dispatch = rows.map(
    (row, index): DispatchEntry => ({
      entityIndex: row.entityKey,
      renderableIndex: index,
      materialHandle: 0,
      passIndex: 0,
      queue: 2000,
      layer: 0,
      tags: { LightMode: 'Forward' },
      renderState: undefined,
      defines: undefined,
      vertexEntry: undefined,
      fragmentEntry: undefined,
      materialShaderId: undefined,
    }),
  );
  const ensureResident = vi.spyOn(gpuStore, 'ensureResident');
  const createTexture = vi.spyOn(device, 'createTexture');
  const project = () =>
    projectSubmittedWorkset({
      hasCamera: true,
      hasEnvironment: true,
      environmentReady: true,
      submissionRenderables: rows,
      submissionDispatch: dispatch,
      preparedSource: world,
      internals: { gpuStore } as RenderSystemInternals,
    });
  try {
    expect(project().presentation).toBe('ready');
    expect(createTexture).toHaveBeenCalledTimes(2);
    expect(ensureResident).toHaveBeenCalledTimes(2);
    gpuStore.invalidateTexture(handles[0], worldRenderResources(world));
    expect(project().presentation).toBe('ready');
    expect(createTexture).toHaveBeenCalledTimes(3);
    expect(ensureResident).toHaveBeenCalledTimes(4);
  } finally {
    gpuStore.destroyAll();
    assets.dispose();
  }
});

it('selects the display workset without reading or preparing material resources', () => {
  const materialRead = vi.fn(() => {
    throw Error('material observation precedes submission');
  });
  const row = {
    authorVisible: true,
    get materials() {
      return materialRead();
    },
  } as unknown as RenderableSnapshot;
  const dispatch: DispatchEntry = {
    entityIndex: 0,
    materialHandle: 0,
    renderableIndex: 0,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: 'Forward' },
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: undefined,
  };
  expect(projectDisplayRenderables([row], [dispatch])).toEqual([row]);
  expect(materialRead).not.toHaveBeenCalled();
  expect(
    projectDisplayRenderables([row], [{ ...dispatch, tags: { LightMode: 'ShadowCaster' } }]),
  ).toEqual([]);

  const layered = [{ authorVisible: true, renderLayers: 2 } as RenderableSnapshot];
  const forward = [dispatch];
  expect(projectDisplayRenderables(layered, forward, { cullMask: 1 })).toEqual([]);
  expect(projectDisplayRenderables(layered, forward, { cullMask: 2 })).toEqual(layered);
  expect(projectDisplayRenderables(layered, forward, { cullMask: 1 })).toEqual([]);
  expect(projectDisplayRenderables(layered, forward)).toEqual(layered);
});

it('keeps failed material bindings pending after submission', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const handle = assets
    .create<TextureAsset>({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(4),
    })
    .unwrap();
  assets.release(handle).unwrap();
  const material = MaterialResource.from({
    ...defaultMaterialSnapshot(),
    baseColorTexture: handle,
  });
  const row: RenderableSnapshot = {
    assetHandle: 0,
    entityKey: 1,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    material,
    materials: [material],
    materialBindingSources: [],
  };
  expect(
    projectFramePresentation({
      renderables: [row],
      preparedSourceScope: worldRenderResources(world),
      internals: {} as RenderSystemInternals,
    }),
  ).toBe('pending');
});

it('attributes one submitted sprite fold to every validated source member', () => {
  const head = { renderableIndex: 8 } as ValidatedRenderable;
  const tail = { renderableIndex: 3 } as ValidatedRenderable;
  const unrelated = { renderableIndex: 12 } as ValidatedRenderable;
  const record = vi.fn();
  const submitted = createFoldedDrawRecorder({
    validatedOrdered: [tail, unrelated, head],
    onRenderableDraw: record,
  });
  const bucket = {
    entries: [{ renderableIndex: 8 }, { renderableIndex: 3 }, { renderableIndex: 99 }],
  } as unknown as FoldBucket;
  expect(record).not.toHaveBeenCalled();
  submitted(head, 0, undefined, bucket);
  expect(record.mock.calls.map(([entry]) => entry)).toEqual([head, tail]);
  expect(record.mock.calls.every(([, submesh]) => submesh === 0)).toBe(true);
  record.mockClear();
  submitted(unrelated, 2);
  expect(record).toHaveBeenCalledExactlyOnceWith(unrelated, 2, undefined);
});

it('keeps the first preparation owner and starts the next frame without a stale cause', () => {
  const state: {
    pipelinePreparationPending?: boolean;
    pipelinePreparationPendingReason?: import('../render-contract').FramePresentationPendingReason;
  } = {};
  markPipelinePreparationPending(state, { code: 'feature-preparation', featureIdentity: 'first' });
  markPipelinePreparationPending(state, { code: 'shadow-pipeline-preparation', shader: 'second' });
  expect(state.pipelinePreparationPending).toBe(true);
  expect(state.pipelinePreparationPendingReason).toEqual({
    code: 'feature-preparation',
    featureIdentity: 'first',
  });
  expect(Object.isFrozen(state.pipelinePreparationPendingReason)).toBe(true);
  state.pipelinePreparationPending = false;
  delete state.pipelinePreparationPendingReason;
  markPipelinePreparationPending(state, { code: 'scene-pipeline-preparation', pass: 'fs_gbuffer' });
  expect(state.pipelinePreparationPendingReason).toEqual({
    code: 'scene-pipeline-preparation',
    pass: 'fs_gbuffer',
  });
});

it('settles rotating sparse draw receipts with one geometry walk and the first current material user', () => {
  const world = new World({ assets: new AssetRegistry() });
  const scope = worldRenderResources(world);
  const material = MaterialResource.from(captureMaterialSnapshot(defaultMaterialSnapshot()));
  const video = MaterialResource.from(
    captureMaterialSnapshot({
      ...defaultMaterialSnapshot(),
      videoTextureFields: new Map([['clip', 1 as AssetHandle<'video'>]]),
    }),
  );
  const bindings = new MaterialFrame(undefined).with(material).with(video);
  const matrix = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const scene = new RenderScene();
  const row = (entityKey: number, resource: MaterialResource): RenderableSnapshot => ({
    entityKey,
    assetHandle: 1,
    transform: { world: matrix },
    material: resource,
    materials: [resource],
    materialBindingSources: ['engine-default'],
  });
  const count = 96;
  scene.apply(
    Array.from({ length: count }, (_, entityKey) => ({
      kind: 'update' as const,
      entityKey,
      snapshot: row(entityKey, material),
    })),
  );
  const mesh = { submeshes: [{}] };
  const getView = vi.fn<() => unknown>(() => undefined);
  const internals = {
    gpuStore: { getMeshGpuHandles: () => mesh },
    dynamicTextureStore: { getView },
  } as unknown as RenderSystemInternals;
  const walk = vi.spyOn(SceneSlotFrame.prototype, 'findContent');
  const onPending = vi.fn();
  let previous = 0;
  try {
    for (let frame = 0; frame < 60; frame++) {
      const entity = (frame * 17 + 4) % count;
      scene.apply([
        { kind: 'update', entityKey: previous, snapshot: row(previous, material) },
        { kind: 'update', entityKey: entity, snapshot: row(entity, video) },
      ]);
      previous = entity;
      const draws = createPresentationDraws();
      const missing = frame % 3 === 0;
      for (let slot = 0; slot < count - Number(missing); slot++) draws.record(slot, 0);
      const ready = frame % 3 === 2;
      getView.mockClear().mockReturnValue(ready ? {} : undefined);
      onPending.mockClear();
      walk.mockClear();
      const result = projectFramePresentation({
        renderables: scene.materialize(undefined, bindings),
        draws,
        preparedSourceScope: scope,
        internals,
        onPending,
      });
      expect(walk).toHaveBeenCalledTimes(1);
      expect(result).toBe(ready ? 'ready' : 'pending');
      expect(getView).toHaveBeenCalledTimes(missing ? 0 : 1);
      if (missing)
        expect(onPending).toHaveBeenCalledWith({ code: 'draw-entity-missing', entity: count - 1 });
      else if (!ready)
        expect(onPending).toHaveBeenCalledWith({ code: 'material-residency', entity });
    }
  } finally {
    walk.mockRestore();
  }
});

it('reads changing display evidence in occupied row order without requesting poses', () => {
  const world = new World({ assets: new AssetRegistry() });
  const scope = worldRenderResources(world);
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const matrix = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const rows = Array.from(
    { length: 131 },
    (_, entityKey): RenderableSnapshot => ({
      entityKey,
      assetHandle: entityKey,
      transform: { world: matrix },
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
    }),
  );
  const scene = new RenderScene();
  scene.apply(
    rows.map((snapshot) => ({ kind: 'update', entityKey: snapshot.entityKey, snapshot })),
  );
  scene.apply(
    rows
      .filter((row) => row.entityKey % 3 === 1)
      .map((row) => ({ kind: 'remove', entityKey: row.entityKey })),
  );
  const handles = { submeshes: [{}] };
  const getMeshGpuHandles = vi.fn(() => handles);
  const internals = { gpuStore: { getMeshGpuHandles } } as unknown as RenderSystemInternals;
  const views = vi.spyOn(RowViews.prototype, 'read');
  try {
    const live = rows.filter((row) => row.entityKey % 3 !== 1);
    for (let frame = 0; frame < 100; frame++) {
      const moving = live[frame % live.length] as RenderableSnapshot;
      matrix[12] = frame + 1;
      scene.apply([{ kind: 'update', entityKey: moving.entityKey, world: matrix }]);
      const renderables = scene.materialize();
      const draws = createPresentationDraws();
      for (const row of live) if (row !== moving) draws.record(row.entityKey, 0);
      views.mockClear();
      expect(missingDrawEvidence(renderables, draws, scope, internals)).toEqual({
        code: 'draw-entity-missing',
        entity: moving.entityKey,
      });
      draws.record(moving.entityKey, 0);
      expect(missingDrawEvidence(renderables, draws, scope, internals)).toBeUndefined();
      expect(projectFramePresentation({ renderables, preparedSourceScope: scope, internals })).toBe(
        'ready',
      );
      expect(views).not.toHaveBeenCalled();
    }
    // Rotate a proper, sparse subset of this fixed Scene, including a duplicate pass
    // and a ShadowCaster. Receipts read its actual material/geometry but never its pose.
    const previouslySelected: { rows: ReturnType<typeof scene.materialize>; expected: number[] }[] =
      [];
    for (let tick = 0; tick < 60; tick++) {
      const moving = live[tick % live.length] as RenderableSnapshot;
      matrix[12] = 101 + tick;
      scene.apply([{ kind: 'update', entityKey: moving.entityKey, world: matrix }]);
      const ranks = [tick % 19, 24 + (tick % 14), 67 + (tick % 19)] as const;
      const pass = (rank: number, mode: string) =>
        ({ renderableIndex: rank, tags: { LightMode: mode } }) as DispatchEntry;
      views.mockClear();
      const selected = projectDisplayRenderables(scene.materialize(), [
        pass(ranks[2], 'Forward'),
        pass(ranks[0], 'Forward'),
        pass(ranks[1], 'Forward'),
        pass(ranks[2], 'Forward'),
        pass(20, 'ShadowCaster'),
      ]);
      const expected = ranks.map((rank) => {
        const row = live[rank];
        if (row === undefined) throw new Error('Missing fixture display row');
        return row.entityKey;
      });
      expect(selected.length).toBe(3);
      const second = projectDisplayRenderables(selected, [
        pass(1, 'Forward'),
        pass(2, 'ShadowCaster'),
      ]);
      const middle = expected[1];
      if (middle === undefined) throw new Error('Missing selected middle row');
      expect(missingDrawEvidence(second, createPresentationDraws(), scope, internals)).toEqual({
        code: 'draw-entity-missing',
        entity: middle,
      });
      expect(views).not.toHaveBeenCalled();
      const draws = createPresentationDraws();
      const first = expected[0];
      if (first === undefined) throw new Error('Missing first fixture display row');
      draws.record(first, 0);
      expect(missingDrawEvidence(selected, draws, scope, internals)).toEqual({
        code: 'draw-entity-missing',
        entity: expected[1],
      });
      for (const id of expected) draws.record(id, 0);
      expect(missingDrawEvidence(selected, draws, scope, internals)).toBeUndefined();
      expect(
        projectFramePresentation({ renderables: selected, preparedSourceScope: scope, internals }),
      ).toBe('ready');
      expect(views).not.toHaveBeenCalled();
      if (tick === 0 || tick === 59) previouslySelected.push({ rows: selected, expected });
    }
    for (const { rows: selected, expected } of previouslySelected) {
      expect(Array.from(selected, (row) => row.entityKey)).toEqual(expected);
      expect(selected.at(-1)?.entityKey).toBe(expected.at(-1));
    }
    const renderables = scene.materialize();
    const borrowed = { ...rows[0], entityKey: 501 } as RenderableSnapshot;
    Object.defineProperty(renderables, Symbol.iterator, {
      value: () => [borrowed][Symbol.iterator](),
    });
    expect(missingDrawEvidence(renderables, createPresentationDraws(), scope, internals)).toEqual({
      code: 'draw-entity-missing',
      entity: 501,
    });
  } finally {
    views.mockRestore();
  }
});
