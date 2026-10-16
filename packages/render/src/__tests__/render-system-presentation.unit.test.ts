import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { type TextureAsset, toShared } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { createFoldedDrawRecorder } from '../record/fold-instance-buffer';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { FoldBucket } from '../record/mesh-ssbo';
import type { RenderSystemInternals } from '../record/render-context';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type MaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import {
  createPresentationDraws,
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
          preparedWorlds: input.preparedWorlds,
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
          material: defaultMaterialSnapshot(),
          materials: [defaultMaterialSnapshot()],
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
          paramSnapshot: undefined,
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
  const world = new World();
  const material = {
    ...defaultMaterialSnapshot(),
    videoTextureFields: new Map([['clip', toShared<'VideoAsset'>(1)]]),
  };
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
        paramSnapshot: undefined,
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
  gpuStore.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('no cubemap');
    },
    device.caps,
  );
  const worlds = [new World(), new World()] as const;
  const texture: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'packed', levelCount: 1 },
    data: new Uint8Array(64),
  };
  const handles = [
    worlds[0].allocSharedRef('TextureAsset', texture),
    worlds[1].allocSharedRef('TextureAsset', texture),
  ] as const;
  expect(handles[0]).toBe(handles[1]);
  const material: MaterialSnapshot = {
    ...defaultMaterialSnapshot(),
    baseColorTexture: handles[0],
  };
  const rows = Array.from(
    { length: 200 },
    (_, index): RenderableSnapshot => ({
      worldId: index % 2,
      authorVisible: true,
      assetHandle: 0,
      entityKey: index + 1,
      transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
      material,
      materials: [material],
      materialBindingSources: [],
    }),
  );
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
      paramSnapshot: undefined,
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
    gpuStore.invalidateTexture(handles[0], worlds[0]);
    expect(project().presentation).toBe('ready');
    expect(createTexture).toHaveBeenCalledTimes(3);
    expect(ensureResident).toHaveBeenCalledTimes(4);
  } finally {
    gpuStore.destroyAll();
    worlds[0].sharedRefs.release(handles[0]).unwrap();
    worlds[1].sharedRefs.release(handles[1]).unwrap();
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
    paramSnapshot: undefined,
  };
  expect(projectDisplayRenderables([row], [dispatch])).toEqual([row]);
  expect(materialRead).not.toHaveBeenCalled();
  expect(
    projectDisplayRenderables([row], [{ ...dispatch, tags: { LightMode: 'ShadowCaster' } }]),
  ).toEqual([]);
});

it('keeps failed material bindings pending after submission', () => {
  const world = new World();
  const handle = world.allocSharedRef('TextureAsset', {} as TextureAsset);
  world.sharedRefs.release(handle).unwrap();
  const material = { ...defaultMaterialSnapshot(), baseColorTexture: handle };
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
      preparedWorlds: [world],
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
