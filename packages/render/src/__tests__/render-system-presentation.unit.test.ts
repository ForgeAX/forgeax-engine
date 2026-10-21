import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { AssetHandle, TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { MaterialResource } from '../material-resource';
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
  projectDisplayRenderables,
  projectFramePresentation,
} from '../render-system-presentation';

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

function projectSubmittedWorkset(input: {
  hasCamera: boolean;
  hasEnvironment: boolean;
  environmentReady: boolean;
  submissionRenderables: readonly RenderableSnapshot[];
  submissionDispatch: readonly DispatchEntry[];
  preparedWorlds: readonly World[];
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
          preparedWorlds: input.preparedWorlds.map(worldRenderResources),
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
          worldId: 0,
          authorVisible: true,
          assetHandle: 0,
          entityKey: 1,
          transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
          material: MaterialResource.from(defaultMaterialSnapshot()),
          materials: [MaterialResource.from(defaultMaterialSnapshot())],
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
      // An absent material world makes residency pending; no GPU mock is needed.
      preparedWorlds: [],
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
        worldId: 0,
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
      preparedWorlds: [world],
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
  const owners = [new AssetRegistry(), new AssetRegistry()] as const;
  const worlds = [new World({ assets: owners[0] }), new World({ assets: owners[1] })] as const;
  const texture: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'packed', levelCount: 1 },
    data: new Uint8Array(64),
  };
  const handles = [owners[0].create(texture).unwrap(), owners[1].create(texture).unwrap()] as const;
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
      worldId: index % 2,
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
      preparedWorlds: worlds,
      internals: { gpuStore } as RenderSystemInternals,
    });
  try {
    expect(project().presentation).toBe('ready');
    expect(createTexture).toHaveBeenCalledTimes(2);
    expect(ensureResident).toHaveBeenCalledTimes(2);
    gpuStore.invalidateTexture(handles[0], worldRenderResources(worlds[0]));
    expect(project().presentation).toBe('ready');
    expect(createTexture).toHaveBeenCalledTimes(3);
    expect(ensureResident).toHaveBeenCalledTimes(4);
  } finally {
    gpuStore.destroyAll();
    owners.forEach((owner) => {
      owner.dispose();
    });
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
    worldId: 0,
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
      preparedWorlds: [world].map(worldRenderResources),
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
