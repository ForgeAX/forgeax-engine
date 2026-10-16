import { type BindGroup, type RenderPipeline, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFeatureGpuBufferRef } from '../features/prepared-gpu-work';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsItem,
} from '../features/prepared-graphics-store';
import { createRenderFeatureTarget } from '../features/targets';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolverInput,
} from '../prepare/prepared-graphics-resolver';

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
