import { type BindGroup, type RenderPipeline, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { materialPipelineAttachments } from '../assembly/material-shader-policy';
import type { RenderFeaturePreparedGraphicsResolverInput } from '../features/host';
import type { RenderFeatureMaterialShaderContract } from '../features/plan';
import type { RenderFeatureGpuBufferRef } from '../features/prepared-gpu-work';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsItem,
} from '../features/prepared-graphics-store';
import { createPreparedResolver } from '../features/prepared-resolver';
import { createRenderFeatureTarget } from '../features/targets';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolverInput,
} from '../prepare/prepared-graphics-resolver';
import { createPreparedResolverCaches } from '../record/prepared-material-bindings';
import type { RenderSystemInternals } from '../record/render-context';
import type { WaterInfoFramePublication } from '../water/water-info-feature';

async function device() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  return (await adapter.requestDevice()).unwrap();
}

function resultMap(items: readonly PreparedGraphicsItem[]): Map<object, PreparedGraphicsItem> {
  return new Map(items.map((item) => [item.reference, item]));
}

function failure<T>(result: Result<T, unknown>): {
  readonly code: string;
  readonly detail?: { readonly reason: string };
} {
  if (result.ok) throw new Error('expected a resolver failure');
  return result.error as {
    readonly code: string;
    readonly detail?: { readonly reason: string };
  };
}

describe('prepared graphics resolver', () => {
  it('preserves a colorless storage fragment stage through the actual prepared pipeline request', async () => {
    const currentDevice = await device();
    const shader = (await rhi.createShaderModule(currentDevice, { code: 'synthetic' })).unwrap();
    const createPipeline = vi.spyOn(currentDevice, 'createRenderPipeline');
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.storage', 1);
    const pipeline = transaction
      .prepare('pipeline', 'raster', {
        shader: 'synthetic::storage',
        vertexLayout: 'water-info-position-flow',
        colorFormats: [],
        depthFormat: 'depth32float-stencil8',
        preparePipelines: true,
        renderState: { depthWriteEnabled: false, depthCompare: 'less-equal' },
      })
      .unwrap();
    const bindings = transaction
      .prepare('bindings', 'storage', {
        pipeline,
        values: { bufferBindings: [{ binding: 2, resource: 'visibility', access: 'read-write' }] },
      })
      .unwrap();
    transaction.commit().unwrap();
    const items = resultMap(store.snapshot('resolver.storage').items);
    const prepare = vi.fn(
      (
        ...args: Parameters<
          NonNullable<RenderSystemInternals['prepareMaterialShaderPipelineEntry']>
        >
      ) => {
        const attachments = materialPipelineAttachments(
          args[6] ?? 'forward',
          args[9] === undefined ? 'bgra8unorm-srgb' : args[9],
          args[17],
          args[11],
          args[8] ?? 1,
        );
        return {
          pipeline: buildPipelineForMaterialShader(
            args[0],
            {
              source: `@group(0) @binding(2) var<storage, read_write> visibility: array<atomic<u32>>;
          @vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
          @fragment fn fs_shadow() { atomicStore(&visibility[0], 1u); }`,
              paramSchema: [],
            },
            {
              device: currentDevice,
              shaderModuleFactory: { createShaderModule: () => ok(shader) },
              pipelineLayout: currentDevice.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
              vertexBuffers: [],
              colorFormat: 'bgra8unorm-srgb',
              colorFormats: attachments.colorFormats,
              depthFormat: attachments.depthFormat,
            },
            args[2],
            undefined,
            undefined,
            undefined,
            undefined,
            args[6],
            args[8],
          ).unwrap(),
        };
      },
    );
    const resolver = createPreparedResolver(
      {
        runtime: {
          device: currentDevice,
          prepareMaterialShaderPipelineEntry: prepare,
        } as unknown as RenderSystemInternals,
        caches: createPreparedResolverCaches(),
        gpuWork: {} as never,
        builtinPostProcessEntries: new Map(),
        skylightResources: () => undefined,
      },
      {
        featureIdentity: 'resolver.storage',
        order: 0,
        generation: 1,
        transaction,
        fullscreenEffects: new Map(),
        graphicsBindings: new Map([['storage', bindings]]),
        lookup: (reference) => items.get(reference),
      },
      [],
    );
    expect(resolver.resolve(pipeline).ok).toBe(true);
    expect(prepare.mock.calls[0]?.[23]).toBe(true);
    expect(createPipeline.mock.calls[0]?.[0]).toMatchObject({
      fragment: { entryPoint: 'fs_shadow', targets: [] },
      depthStencil: {
        format: 'depth32float-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
    });
    expect(prepare.mock.calls[0]?.[9]).toBeNull();
    resolver.release().unwrap();
  });

  it.each([
    false,
    true,
  ])('preserves every declared color attachment in material pipeline preparation: entry=%s', async (entry) => {
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.mrt', 1);
    const pipeline = transaction
      .prepare('pipeline', 'raster', {
        shader: 'synthetic::mrt',
        preparePipelines: true,
        vertexLayout: 'position',
        colorFormats: ['rgb10a2unorm', 'rgba16float'],
        sampleCount: 4,
      })
      .unwrap();
    transaction.commit().unwrap();
    const items = resultMap(store.snapshot('resolver.mrt').items);
    const prepare = vi.fn(() =>
      entry ? { pipeline: {} as RenderPipeline } : ({} as RenderPipeline),
    );
    const runtime = {
      device: await device(),
      [entry ? 'prepareMaterialShaderPipelineEntry' : 'prepareMaterialShaderPipeline']: prepare,
    } as unknown as RenderSystemInternals;
    const resolver = createPreparedResolver(
      {
        runtime,
        caches: createPreparedResolverCaches(),
        gpuWork: {} as never,
        builtinPostProcessEntries: new Map(),
        skylightResources: () => undefined,
      },
      {
        featureIdentity: 'resolver.mrt',
        order: 0,
        generation: 1,
        transaction,
        fullscreenEffects: new Map(),
        lookup: (reference) => items.get(reference),
      },
      [],
    );
    expect(resolver.resolve(pipeline).ok).toBe(true);
    expect(prepare.mock.calls[0]?.[9]).toBe('rgb10a2unorm');
    expect(prepare.mock.calls[0]?.[17]).toEqual(['rgba16float']);
    resolver.release().unwrap();
  });

  it.each([
    undefined,
    true,
    false,
  ])('derives depth writes from the pipeline material state: %s', async (depthWriteEnabled) => {
    const currentDevice = await device();
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.depth-writes', 1);
    const pipeline = transaction
      .prepare('pipeline', 'depth', {
        shader: 'synthetic::depth',
        vertexLayout: 'none',
        colorFormats: ['rgba8unorm'],
        depthFormat: 'depth32float-stencil8',
        ...(depthWriteEnabled === undefined ? {} : { renderState: { depthWriteEnabled } }),
      })
      .unwrap();
    transaction.commit().unwrap();
    const items = resultMap(store.snapshot('resolver.depth-writes').items);
    const resolver = createPreparedGraphicsResolver({
      device: currentDevice,
      generation: 1,
      capabilityAvailable: true,
      lookup: (reference) => items.get(reference),
      resolvePipeline: () => ok({} as RenderPipeline),
      resolveBindings: () => ok(undefined),
    });
    try {
      expect(resolver.resolve(pipeline).unwrap()).toMatchObject({
        writesDepth: depthWriteEnabled !== false,
      });
    } finally {
      resolver.release().unwrap();
    }
  });

  it('lets the render owner decide whether a scene target is a deferred binding', async () => {
    const currentDevice = await device();
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.scene-target', 1);
    const pipeline = transaction.prepare('pipeline', 'forward', {
      shader: 'synthetic::view-only',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    });
    const bindings = transaction.prepare('bindings', 'view', {
      pipeline: pipeline.unwrap(),
      values: {
        sceneDepth: createRenderFeatureTarget({
          kind: 'scene-depth',
          format: 'depth24plus-stencil8',
          sampleCount: 1,
        }),
      },
    });
    transaction.commit().unwrap();
    const lookup = resultMap(store.snapshot('resolver.scene-target').items);
    const resolvedView = {} as BindGroup;
    const resolveBindings = vi.fn(() => ok(resolvedView));
    const resolver = createPreparedGraphicsResolver({
      device: currentDevice,
      generation: 1,
      capabilityAvailable: true,
      lookup: (reference) => lookup.get(reference),
      resolvePipeline: () => ok({} as RenderPipeline),
      resolveBindings,
    });

    const result = resolver.resolve(bindings.unwrap());

    expect(result.ok && result.value.handle).toBe(resolvedView);
    expect(resolveBindings).toHaveBeenCalledOnce();
  });

  it('releases producer binding resources exactly once', async () => {
    const currentDevice = await device();
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.binding-lifetime', 1);
    const pipeline = transaction.prepare('pipeline', 'forward', {
      shader: 'synthetic::forward',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    });
    const bindings = transaction.prepare('bindings', 'material', {
      pipeline: pipeline.unwrap(),
      values: { group: 1 },
    });
    transaction.commit().unwrap();
    const lookup = resultMap(store.snapshot('resolver.binding-lifetime').items);
    const release = vi.fn(() => ok(undefined));
    const resolver = createPreparedGraphicsResolver({
      device: currentDevice,
      generation: 1,
      capabilityAvailable: true,
      lookup: (reference) => lookup.get(reference),
      resolvePipeline: () => ok({} as RenderPipeline),
      resolveBindings: () => ok({ handle: {} as BindGroup, release }),
    });

    expect(resolver.resolve(bindings.unwrap()).ok).toBe(true);
    expect(resolver.requiresGraphRebuild).toBe(false);
    expect(resolver.leases).toHaveLength(1);
    expect(resolver.release().ok).toBe(true);
    expect(resolver.release().ok).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('maps normalized operations to current-device handles without using refs as handles', async () => {
    const currentDevice = await device();
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.feature', 7);
    const pipeline = transaction.prepare('pipeline', 'forward', {
      shader: 'synthetic::forward',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    });
    const bindings = transaction.prepare('bindings', 'forward', {
      pipeline: pipeline.unwrap(),
      values: { tint: [1, 0, 0, 1] },
    });
    const vertex = transaction.prepare('vertex-data', 'triangle', {
      layout: 'position',
      data: new Float32Array([0, 1, 2]),
    });
    const index = transaction.prepare('index-data', 'triangle', {
      format: 'uint16',
      data: new Uint16Array([0, 1, 2]),
    });
    const externalBuffer = currentDevice.createBuffer({ size: 16, usage: 56 }).unwrap();
    const externalRef = Object.freeze({
      name: 'external-geometry',
      generation: 7,
    }) as RenderFeatureGpuBufferRef;
    const externalVertex = transaction.prepare('vertex-data', 'external-vertices', {
      layout: 'position',
      buffer: externalRef,
    });
    const externalIndex = transaction.prepare('index-data', 'external-indices', {
      format: 'uint16',
      buffer: externalRef,
    });
    expect(transaction.commit().ok).toBe(true);

    const items = store.snapshot('resolver.feature').items;
    const lookup = resultMap(items);
    const shader = (await rhi.createShaderModule(currentDevice, { code: 'synthetic' })).unwrap();
    const input: PreparedGraphicsResolverInput = {
      device: currentDevice,
      generation: 7,
      capabilityAvailable: true,
      lookup: (ref) => lookup.get(ref),
      resolvePipeline: () =>
        currentDevice.createRenderPipeline({
          layout: 'auto',
          vertex: { module: shader, entryPoint: 'main', buffers: [] },
          fragment: { module: shader, entryPoint: 'main', targets: [] },
        }) as Result<RenderPipeline, never>,
      resolveBindings: () => {
        const layout = currentDevice.createBindGroupLayout({ entries: [] }).unwrap();
        return currentDevice.createBindGroup({ layout, entries: [] }) as Result<BindGroup, never>;
      },
      resolveGpuBuffer: (reference) =>
        reference === externalRef
          ? { buffer: externalBuffer, size: 64, physicalUsage: 0x0020 }
          : undefined,
    };
    const resolver = createPreparedGraphicsResolver(input);
    const pipelineRef = pipeline.unwrap();
    const bindingsRef = bindings.unwrap();
    const vertexRef = vertex.unwrap();
    const indexRef = index.unwrap();
    const resolvedPipeline = resolver.resolve(pipelineRef);
    const resolvedBindings = resolver.resolve(bindingsRef);
    const resolvedVertex = resolver.resolve(vertexRef);
    const resolvedIndex = resolver.resolve(indexRef);
    expect(resolver.requiresGraphRebuild).toBe(true);
    const resolvedExternalVertex = resolver.resolve(externalVertex.unwrap());
    const resolvedExternalIndex = resolver.resolve(externalIndex.unwrap());

    expect(resolvedPipeline.ok).toBe(true);
    expect(resolvedBindings.ok).toBe(true);
    expect(resolvedVertex.ok).toBe(true);
    expect(resolvedIndex.ok).toBe(true);
    expect(resolvedExternalVertex.ok && resolvedExternalVertex.value.handle).toBe(externalBuffer);
    expect(resolvedExternalIndex.ok && resolvedExternalIndex.value.handle).toBe(externalBuffer);
    expect(resolvedPipeline.ok && resolvedPipeline.value.handle).not.toBe(pipelineRef);
    expect(resolvedBindings.ok && resolvedBindings.value.handle).not.toBe(bindingsRef);
    expect(resolvedVertex.ok && resolvedVertex.value.handle).not.toBe(vertexRef);
    expect(resolvedIndex.ok && resolvedIndex.value.handle).not.toBe(indexRef);
  });

  it('rejects capability, resolution, stale, and forged refs before record mutation', async () => {
    const currentDevice = await device();
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.failure', 3);
    const pipeline = transaction.prepare('pipeline', 'forward', {
      shader: 'synthetic::forward',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    });
    expect(transaction.commit().ok).toBe(true);
    const lookup = resultMap(store.snapshot('resolver.failure').items);
    let resolveCalls = 0;
    const base: PreparedGraphicsResolverInput = {
      device: currentDevice,
      generation: 3,
      capabilityAvailable: true,
      lookup: (ref) => lookup.get(ref),
      resolvePipeline: () => {
        resolveCalls += 1;
        return ok({} as RenderPipeline);
      },
      resolveBindings: () => ok({} as BindGroup),
    };

    const pipelineRef = pipeline.unwrap();
    const unavailable = createPreparedGraphicsResolver({
      ...base,
      capabilityAvailable: false,
    }).resolve(pipelineRef);
    expect(unavailable.ok).toBe(false);
    expect(failure(unavailable).code).toBe('render-feature-preparation-failed');
    expect(resolveCalls).toBe(0);

    const stale = createPreparedGraphicsResolver({ ...base, generation: 4 }).resolve(pipelineRef);
    expect(stale.ok).toBe(false);
    const staleError = failure(stale);
    expect(staleError.code).toBe('render-feature-prepared-state-mismatch');
    expect(staleError.detail?.reason).toBe('generation-mismatch');
    expect(resolveCalls).toBe(0);

    const forged = createPreparedGraphicsResolver(base).resolve({
      kind: 'pipeline',
      generation: 3,
    });
    expect(forged.ok).toBe(false);
    const forgedError = failure(forged);
    expect(forgedError.code).toBe('render-feature-prepared-state-mismatch');
    expect(forgedError.detail?.reason).toBe('missing-prepared-state');
    expect(resolveCalls).toBe(0);

    const failed = createPreparedGraphicsResolver({
      ...base,
      resolvePipeline: () => {
        resolveCalls += 1;
        return ok(undefined as never);
      },
    }).resolve(pipelineRef);
    expect(failed.ok).toBe(false);
    expect(failure(failed).code).toBe('render-feature-preparation-failed');
    expect(resolveCalls).toBe(1);
  });

  it('preserves asynchronous pipeline warm-up as the graph-level pending reason', async () => {
    const currentDevice = await device();
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.warmup', 5);
    const pipeline = transaction.prepare('pipeline', 'forward', {
      shader: 'synthetic::forward',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    });
    expect(transaction.commit().ok).toBe(true);
    const lookup = resultMap(store.snapshot('resolver.warmup').items);

    const pending = createPreparedGraphicsResolver({
      device: currentDevice,
      generation: 5,
      capabilityAvailable: true,
      lookup: (ref) => lookup.get(ref),
      resolvePipeline: () =>
        err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'asynchronous shader module warm-up to finish',
            hint: 'retry on the next frame',
          }),
        ),
      resolveBindings: () => ok({} as BindGroup),
    }).resolve(pipeline.unwrap());

    expect(pending.ok).toBe(false);
    expect(failure(pending)).toMatchObject({
      code: 'render-feature-preparation-failed',
      detail: { reason: 'pipeline-pending' },
    });
  });
});

async function preparedWaterOwner(format: 'rgba16float' | 'rgba32float' = 'rgba16float') {
  const store = createPreparedGraphicsStore();
  const transaction = store.beginFrame('resolver.water-system', 1);
  const pipeline = transaction
    .prepare('pipeline', 'underwater', {
      shader: 'synthetic::underwater',
      preparePipelines: true,
      vertexLayout: 'none',
      colorFormats: ['rgba16float'],
    })
    .unwrap();
  const entryPoints = [
    { name: 'fs_main', stage: 'fragment' as const, bindings: [{ group: 2, binding: 18 }] },
  ];
  const bindings = transaction
    .prepare('bindings', 'water', {
      pipeline,
      values: {
        group: 2,
        waterMaterial: {
          bodyKey: 'body',
          viewIdentity: 'view',
          bodyGeneration: 3,
          zoneGeneration: 4,
          programInputs: { entryPoints, systemInputs: { water: 'water-frame/3' } },
        },
      },
    })
    .unwrap();
  transaction.commit().unwrap();
  const lookup = resultMap(store.snapshot('resolver.water-system').items);
  const input: RenderFeaturePreparedGraphicsResolverInput = {
    featureIdentity: 'resolver.water-system',
    order: 0,
    generation: 1,
    viewIdentity: 'view',
    frameGeneration: 9,
    deviceGeneration: 2,
    transaction,
    fullscreenEffects: new Map(),
    graphicsBindings: new Map([['water', bindings]]),
    lookup: (reference) => lookup.get(reference),
  };
  let contract: RenderFeatureMaterialShaderContract = {
    bindings: 'post-process',
    systemInputs: { water: 'water-frame/3' },
    entryPoints,
  };
  let publication: WaterInfoFramePublication | undefined = {
    viewIdentity: 'view',
    frameGeneration: 9,
    deviceGeneration: 2,
    targets: [{ targetName: 'water-info', targetFormat: format }],
    waterInfoAvailability: new Map(),
    rows: new Map([
      [
        'body',
        {
          bodyGeneration: 3,
          zoneGeneration: 4,
          frameGeneration: 9,
          deviceGeneration: 2,
          targetName: 'water-info',
          targetFormat: format,
        },
      ],
    ]),
    waveUploadPlan: {
      bodyIndices: new Map([['body', 0]]),
      bodyData: [{ bodyGeneration: 3 }],
      bodyZoneGenerations: new Map([['body', 4]]),
    },
  } as unknown as WaterInfoFramePublication;
  const prepare = vi.fn<NonNullable<RenderSystemInternals['prepareMaterialShaderPipeline']>>(
    () => ({}) as RenderPipeline,
  );
  const getPublication = vi.fn(() => publication);
  const runtime = {
    device: await device(),
    getMaterialShaderBindingContract: () => contract,
    prepareMaterialShaderPipeline: prepare,
    getWaterMaterialFramePublication: getPublication,
  } as unknown as RenderSystemInternals;
  const resolver = createPreparedResolver(
    {
      runtime,
      caches: createPreparedResolverCaches(),
      gpuWork: {} as never,
      builtinPostProcessEntries: new Map(),
      skylightResources: () => undefined,
    },
    input,
    [],
  );
  return {
    resolver,
    pipeline,
    prepare,
    getPublication,
    setContract(next: RenderFeatureMaterialShaderContract) {
      contract = next;
    },
    alterPublication(
      alter: (current: WaterInfoFramePublication) => WaterInfoFramePublication | undefined,
    ) {
      if (publication === undefined) throw new Error('Water publication fixture is absent');
      publication = alter(publication);
    },
  };
}

describe('prepared Water system input', () => {
  it.each([
    'rgba16float',
    'rgba32float',
  ] as const)('prepares the actual scoped WaterInfo format %s without a Surface declaration', async (format) => {
    const owner = await preparedWaterOwner(format);
    expect(owner.resolver.resolve(owner.pipeline).ok).toBe(true);
    expect(owner.getPublication).toHaveBeenCalledWith('view', 9, 2);
    expect(owner.prepare.mock.calls[0]?.[22]).toBe(format);
    owner.resolver.release().unwrap();
  });

  it('requires the accepted Water system ABI before interpreting reflected Water slots', async () => {
    const owner = await preparedWaterOwner();
    owner.setContract({
      bindings: 'post-process',
      entryPoints: [{ name: 'fs_main', stage: 'fragment', bindings: [{ group: 2, binding: 18 }] }],
    });
    expect(owner.resolver.resolve(owner.pipeline).ok).toBe(true);
    expect(owner.getPublication).not.toHaveBeenCalled();
    expect(owner.prepare.mock.calls[0]?.[22]).toBeUndefined();
    owner.resolver.release().unwrap();
  });

  it('allows a declared Body-only Water program with no WaterInfo source', async () => {
    const owner = await preparedWaterOwner();
    owner.setContract({
      bindings: 'post-process',
      systemInputs: { water: 'water-frame/3' },
      entryPoints: [{ name: 'fs_main', stage: 'fragment', bindings: [{ group: 2, binding: 16 }] }],
    });
    owner.alterPublication((publication) => ({ ...publication, rows: new Map(), targets: [] }));
    expect(owner.resolver.resolve(owner.pipeline).ok).toBe(true);
    expect(owner.prepare.mock.calls[0]?.[22]).toBeUndefined();
    owner.resolver.release().unwrap();
  });

  it('waits for the exact owner WaterInfo dependency load before preparing its pipeline', async () => {
    const owner = await preparedWaterOwner();
    let ready: WaterInfoFramePublication | undefined;
    owner.alterPublication((publication) => {
      ready = publication;
      return {
        ...publication,
        rows: new Map(),
        targets: [],
        waterInfoAvailability: new Map([
          [
            'body',
            {
              kind: 'pending',
              bodyGuid: 'river',
              bodyGeneration: 3,
              field: 'waterInfoMeshGuid',
              guid: 'mesh',
            },
          ],
        ]),
      };
    });
    const pending = owner.resolver.resolve(owner.pipeline);
    expect(failure(pending)).toMatchObject({
      code: 'render-feature-preparation-failed',
      detail: { reason: 'pipeline-pending' },
    });
    expect(owner.prepare).not.toHaveBeenCalled();
    owner.alterPublication(() => ready);
    expect(owner.resolver.resolve(owner.pipeline).ok).toBe(true);
    expect(owner.prepare.mock.calls[0]?.[22]).toBe('rgba16float');
    owner.resolver.release().unwrap();
  });

  it.each([
    'failed',
    'missing',
    'incompatible',
  ] as const)('does not wait indefinitely for a %s WaterInfo dependency', async (kind) => {
    const owner = await preparedWaterOwner();
    const reference = {
      bodyGuid: 'river',
      bodyGeneration: 3,
      field: 'waterInfoMeshGuid',
      guid: 'mesh',
    };
    const availability: NonNullable<
      ReturnType<WaterInfoFramePublication['waterInfoAvailability']['get']>
    > =
      kind === 'failed'
        ? {
            ...reference,
            kind,
            failure: { code: 'load-failed', expected: 'mesh loads', hint: 'repair source' },
          }
        : { ...reference, kind };
    owner.alterPublication((publication) => ({
      ...publication,
      rows: new Map(),
      targets: [],
      waterInfoAvailability: new Map([['body', availability]]),
    }));
    expect(failure(owner.resolver.resolve(owner.pipeline))).toMatchObject({
      code: 'render-feature-preparation-failed',
      detail: { reason: 'pipeline resolution failed' },
    });
    expect(owner.prepare).not.toHaveBeenCalled();
    owner.resolver.release().unwrap();
  });

  it('does not use another owner generation to defer a missing WaterInfo row', async () => {
    const owner = await preparedWaterOwner();
    owner.alterPublication((publication) => ({
      ...publication,
      rows: new Map(),
      targets: [],
      waterInfoAvailability: new Map([
        [
          'old-body',
          {
            kind: 'pending',
            bodyGuid: 'river',
            bodyGeneration: 2,
            field: 'waterInfoMeshGuid',
            guid: 'mesh',
          },
        ],
      ]),
    }));
    expect(failure(owner.resolver.resolve(owner.pipeline))).toMatchObject({
      detail: { reason: 'pipeline resolution failed' },
    });
    expect(owner.prepare).not.toHaveBeenCalled();
    owner.resolver.release().unwrap();
  });

  const invalid: readonly (readonly [
    string,
    (publication: WaterInfoFramePublication) => WaterInfoFramePublication | undefined,
  ])[] = [
    ['missing publication', () => undefined],
    ['view', (publication) => ({ ...publication, viewIdentity: 'old-view' })],
    ['frame', (publication) => ({ ...publication, frameGeneration: 8 })],
    ['device', (publication) => ({ ...publication, deviceGeneration: 1 })],
    [
      'Body',
      (publication) => ({
        ...publication,
        waveUploadPlan: {
          ...publication.waveUploadPlan,
          bodyData: publication.waveUploadPlan.bodyData.map((body) => ({
            ...body,
            bodyGeneration: 2,
          })),
        },
      }),
    ],
    [
      'Zone',
      (publication) => ({
        ...publication,
        waveUploadPlan: {
          ...publication.waveUploadPlan,
          bodyZoneGenerations: new Map([['body', 3]]),
        },
      }),
    ],
    [
      'WaterInfo Body',
      (publication) => ({
        ...publication,
        rows: new Map(
          [...publication.rows].map(([key, row]) => [key, { ...row, bodyGeneration: 2 }]),
        ),
      }),
    ],
    [
      'WaterInfo Zone',
      (publication) => ({
        ...publication,
        rows: new Map(
          [...publication.rows].map(([key, row]) => [key, { ...row, zoneGeneration: 3 }]),
        ),
      }),
    ],
    [
      'WaterInfo frame',
      (publication) => ({
        ...publication,
        rows: new Map(
          [...publication.rows].map(([key, row]) => [key, { ...row, frameGeneration: 8 }]),
        ),
      }),
    ],
    [
      'WaterInfo device',
      (publication) => ({
        ...publication,
        rows: new Map(
          [...publication.rows].map(([key, row]) => [key, { ...row, deviceGeneration: 1 }]),
        ),
      }),
    ],
    [
      'WaterInfo target',
      (publication) => ({
        ...publication,
        targets: publication.targets.map((target) => ({ ...target, targetFormat: 'rgba32float' })),
      }),
    ],
    ['missing WaterInfo', (publication) => ({ ...publication, rows: new Map() })],
  ];
  it.each(invalid)('rejects an invalid %s before pipeline preparation', async (_name, alter) => {
    const owner = await preparedWaterOwner();
    owner.alterPublication(alter);
    const result = owner.resolver.resolve(owner.pipeline);
    expect(result.ok).toBe(false);
    expect(failure(result)).toMatchObject({
      code: 'render-feature-preparation-failed',
      detail: { reason: 'pipeline resolution failed' },
    });
    expect(owner.prepare).not.toHaveBeenCalled();
    owner.resolver.release().unwrap();
  });
});
