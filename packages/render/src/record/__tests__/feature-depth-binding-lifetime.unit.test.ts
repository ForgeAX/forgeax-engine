import { World } from '@forgeax/engine-ecs';
import type { RenderPipeline, RhiRenderPipelineOps } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createMaterialLayoutCache } from '../../assembly/material/layout-cache';
import { viewAndSceneDepthLayoutEntries } from '../../assembly/material-shader-policy';
import { DeviceScope } from '../../device/device-scope';
import { createPreparedGraphicsStore } from '../../features/prepared-graphics-store';
import { createPreparedResolver } from '../../features/prepared-resolver';
import { createRenderFeatureTarget } from '../../features/targets';
import { worldRenderResources } from '../../publication/resource-scope';
import { createPreparedResolverCaches } from '../prepared-material-bindings';
import type { RenderSystemInternals } from '../render-context';
import { resolveTargetBindings } from '../typed-frame-graph-bindings';
import { translucentViewOffset, UNFOGGED_VIEW_UNIFORM_OFFSET } from '../view-ubo';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'main', buffers: [] },
      fragment: { module: shader, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
    })
    .unwrap() as RenderPipeline & RhiRenderPipelineOps;
  const buffer = device.createBuffer({ size: 16384, usage: 0x40 | 0x08 }).unwrap();
  const makeDepth = () =>
    device
      .createTexture({
        size: { width: 16, height: 16 },
        format: 'depth32float',
        usage: 0x04 | 0x10,
        textureBindingViewDimension: '2d',
      })
      .unwrap();
  let depth = makeDepth();
  const fallback = device.createTextureView(depth, { aspect: 'depth-only' }).unwrap();
  const state = {
    viewUniformBuffer: buffer,
    shadowFallbackTextureView: fallback,
    atmosphereAvailable: false,
  };
  const runtime = { device, deviceScope: DeviceScope.create(0, 'feature-depth') };
  const frame = {
    runtime,
    frameState: { frameOutputs: {}, viewBindGroupCache: new WeakMap() },
    pipelineState: state,
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  };
  const descriptor = { values: { sceneDepth: 'depth', sceneDepthBinding: 1 } };
  const input = {
    frame,
    binding: { kind: 'bindings', pipeline, descriptor, bindingContract: 'view-and-scene-depth' },
    resources: { texture: () => ({ ok: true, value: depth }) },
    resolveTarget: () => ({ texture: {} }),
  } as unknown as Parameters<typeof resolveTargetBindings>[0];
  return {
    device,
    pipeline,
    buffer,
    state,
    runtime,
    input,
    frame,
    makeDepth,
    setDepth(value: typeof depth) {
      depth = value;
    },
    resolve: () => resolveTargetBindings(input),
  };
}

it('requires an explicit native fog contract and selects the unfogged slot for material features', async () => {
  const f = await fixture();
  Object.assign(f.frame, { vertexHeightFog: true });
  expect(() => f.resolve()).toThrow('forwardFog: height-vertex/1');
  Object.assign(f.input.binding, { forwardFog: 'height-vertex/1', fogComposition: 'straight' });
  const fogged = f.resolve();
  const groups = vi.spyOn(f.device, 'createBindGroup');
  Object.assign(f.input.binding, { fog: false });
  const unfogged = f.resolve();
  expect(unfogged).not.toBe(fogged);
  const viewBinding = Array.from(groups.mock.calls[0]?.[0].entries ?? []).find(
    (entry) => entry.binding === 0,
  );
  expect(viewBinding?.resource).toMatchObject({
    kind: 'buffer',
    value: { offset: UNFOGGED_VIEW_UNIFORM_OFFSET },
  });
  Object.assign(f.input.binding, { fog: undefined });
  expect(f.resolve()).toBe(fogged);
});

it.each([
  'view-and-scene-depth',
  'render-material-and-scene-depth',
] as const)('records the prepared layout without extra Standard resources: %s', async (bindingContract) => {
  const f = await fixture();
  const layoutOwner = createMaterialLayoutCache({
    currentPipelineCacheState: () =>
      ({
        preparedMaterialPipelineLayoutCache: new Map(),
        perShaderMaterialLayoutCache: new Map(),
      }) as never,
    currentPipelineState: () =>
      ({
        ...f.state,
        viewBindGroupLayout: {},
        materialBindGroupLayout: {},
        meshBindGroupLayout: {},
        instancesBindGroupLayout: {},
      }) as never,
    currentBuildDevice: () => f.device,
    getShader: () =>
      ({
        findMaterialArtifact: () => ({
          ok: true,
          value: {
            receipt: { bindings: 'render-material-and-scene-depth' },
            program: { identity: bindingContract },
          },
        }),
      }) as never,
    viewAndSceneDepthLayoutEntries: () => viewAndSceneDepthLayoutEntries(false),
    reportError: (error) => {
      throw error;
    },
  });
  const layouts = vi.spyOn(f.device, 'createBindGroupLayout');
  layoutOwner.getOrBuildPreparedMaterialPipelineLayout('feature::depth');
  const declaration = layouts.mock.calls.find(([descriptor]) =>
    descriptor.label?.startsWith('prepared-material-view-depth'),
  )?.[0];
  expect(declaration).toBeDefined();
  if (declaration === undefined) throw new Error('Missing prepared View/depth layout');
  const layout = f.device.createBindGroupLayout(declaration).unwrap();
  Object.assign(f.input.binding, { bindingContract });
  Object.assign(f.pipeline, { getBindGroupLayout: () => layout });
  const sampler = f.device.createSampler({ compare: 'greater-equal' }).unwrap();
  Object.assign(f.state, {
    perPassResources: { shadowSampler: sampler },
    shadowArrayFallbackTextureView: f.state.shadowFallbackTextureView,
    shadowAtlasFallbackTextureView: f.state.shadowFallbackTextureView,
    shadowParamsBuffer: f.buffer,
    shadowCasterCascadeBuffer: f.buffer,
    defaultWhiteTextureView: f.state.shadowFallbackTextureView,
    defaultSampler: sampler,
    extendedLightingAvailable: false,
    projectorAvailable: false,
  });
  expect(f.device.caps.storageBuffer).toBe(true);
  const create = f.device.createBindGroup.bind(f.device);
  const groups = vi.spyOn(f.device, 'createBindGroup').mockImplementation((descriptor) => {
    expect(descriptor.layout).toBe(layout);
    expect(
      Array.from(descriptor.entries)
        .map((entry) => entry.binding)
        .sort((a, b) => a - b),
    ).toEqual([0, 1]);
    return create(descriptor);
  });
  const resolved = f.resolve();
  expect(resolved).toBeDefined();
  const descriptor = groups.mock.calls.at(-1)?.[0];
  expect(descriptor?.layout).toBe(layout);
  expect(
    Array.from(descriptor?.entries ?? [])
      .map((entry) => entry.binding)
      .sort((a, b) => a - b),
  ).toEqual([0, 1]);
  expect(resolved).not.toHaveProperty('dynamicOffsets');
});

it.each([
  'view-and-scene-depth',
  'render-material-and-scene-depth',
  'render-lit-material-and-scene-depth',
  'render-standard-material-and-scene-depth',
] as const)('carries the selected material binding contract through preparation: %s', async (bindings) => {
  const f = await fixture();
  const store = createPreparedGraphicsStore();
  const transaction = store.beginFrame('feature.depth', 1);
  const pipeline = transaction
    .prepare('pipeline', 'depth', {
      shader: 'feature::depth',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
      depthFormat: 'depth32float',
    })
    .unwrap();
  const group = transaction
    .prepare('bindings', 'view-depth', {
      pipeline,
      values: {
        group: 0,
        sceneDepth: createRenderFeatureTarget({
          kind: 'scene-depth',
          format: 'depth32float',
          sampleCount: 1,
        }),
        sceneDepthBinding: 1,
      },
    })
    .unwrap();
  transaction.commit().unwrap();
  const resolver = createPreparedResolver(
    {
      runtime: {
        device: f.device,
        getMaterialShaderPipelineEntry: () => ({ pipeline: f.pipeline }),
        getMaterialShaderBindingContract: () => ({ bindings }),
      } as unknown as RenderSystemInternals,
      caches: createPreparedResolverCaches(),
      gpuWork: {} as never,
      builtinPostProcessEntries: new Map(),
      skylightResources: () => undefined,
    },
    {
      featureIdentity: 'feature.depth',
      order: 0,
      generation: 1,
      transaction,
      fullscreenEffects: new Map(),
      graphicsBindings: new Map([['view-depth', group]]),
      lookup: (reference) => transaction.lookup(reference),
    },
    worldRenderResources(new World()),
  );
  expect(resolver.resolve(pipeline).unwrap()).toMatchObject({
    kind: 'pipeline',
    bindingContract: bindings,
  });
  expect(resolver.resolve(group).unwrap()).toMatchObject({
    kind: 'bindings',
    bindingContract: bindings,
    handle: undefined,
  });
  resolver.release().unwrap();
});

it.each([
  'render-standard-material-and-scene-depth',
  'render-lit-material-and-scene-depth',
] as const)('retains full lighting/depth and dynamic View offsets: %s', async (bindingContract) => {
  const f = await fixture();
  const sampler = f.device.createSampler({ compare: 'greater-equal' }).unwrap();
  Object.assign(f.state, {
    perPassResources: { shadowSampler: sampler },
    shadowArrayFallbackTextureView: f.state.shadowFallbackTextureView,
    shadowAtlasFallbackTextureView: f.state.shadowFallbackTextureView,
    shadowParamsBuffer: f.buffer,
    shadowCasterCascadeBuffer: f.buffer,
    defaultWhiteTextureView: f.state.shadowFallbackTextureView,
    defaultSampler: sampler,
    extendedLightingAvailable: false,
    projectorAvailable: false,
  });
  Object.assign(f.input.binding, {
    bindingContract,
    fogComposition: 'additive',
  });
  const groups = vi.spyOn(f.device, 'createBindGroup');
  const resolved = f.resolve();
  expect(
    Array.from(groups.mock.calls[0]?.[0].entries ?? [])
      .map((entry) => entry.binding)
      .sort((a, b) => a - b),
  ).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 10, 17]);
  expect(resolved).toMatchObject({
    handle: expect.anything(),
    dynamicOffsets: [translucentViewOffset('additive'), 0],
  });
});

it('reuses current physical depth bindings across draws, uploads and a replaced public descriptor', async () => {
  const f = await fixture();
  const groups = vi.spyOn(f.device, 'createBindGroup');
  const views = vi.spyOn(f.device, 'createTextureView');
  const first = f.resolve();
  f.device.queue.writeBuffer(f.buffer, 0, new Float32Array([1, 2, 3, 4])).unwrap();
  expect(f.resolve()).toBe(first);
  Object.assign(f.input.binding, {
    descriptor: { values: { sceneDepth: 'depth', sceneDepthBinding: 1 } },
  });
  expect(f.resolve()).toBe(first);
  expect(groups).toHaveBeenCalledTimes(1);
  expect(views).toHaveBeenCalledTimes(1);
  expect(f.frame.bindGroupCounts.createBindGroup).toBe(1);
  expect(
    Array.from(groups.mock.calls[0]?.[0].entries ?? [])
      .map((entry) => entry.binding)
      .sort((a, b) => a - b),
  ).toEqual(
    viewAndSceneDepthLayoutEntries(false)
      .map((entry) => entry.binding)
      .sort((a, b) => a - b),
  );
  expect(first).not.toHaveProperty('dynamicOffsets');
});

it('separates actual depth, View buffer, fog offset, pipeline and device-scope replacements', async () => {
  const f = await fixture();
  const first = f.resolve();
  f.setDepth(f.makeDepth());
  const changedDepth = f.resolve();
  expect(changedDepth).not.toBe(first);
  const buffer = f.device.createBuffer({ size: 16384, usage: 0x40 | 0x08 }).unwrap();
  f.state.viewUniformBuffer = buffer;
  const changedBuffer = f.resolve();
  expect(changedBuffer).not.toBe(changedDepth);
  Object.assign(f.input.binding, { fogComposition: 'additive' });
  const changedFog = f.resolve();
  expect(changedFog).not.toBe(changedBuffer);
  Object.assign(f.input.binding, { fogComposition: undefined });
  expect(f.resolve()).toBe(changedBuffer);
  const changedScope = DeviceScope.create(1, 'feature-depth');
  f.runtime.deviceScope = changedScope;
  expect(f.resolve()).not.toBe(changedBuffer);
  const getLayout = f.pipeline.getBindGroupLayout.bind(f.pipeline);
  f.pipeline.getBindGroupLayout = (index) => getLayout(index);
  expect(f.resolve()).not.toBe(changedBuffer);
});

it('does not retain failed native creations and still reads a missing current target', async () => {
  const f = await fixture();
  const failure = new Error('unavailable depth view');
  vi.spyOn(f.device, 'createTextureView').mockImplementationOnce(() => err(failure as never));
  expect(() => f.resolve()).toThrow(failure);
  const groups = vi.spyOn(f.device, 'createBindGroup');
  const first = f.resolve();
  expect(first).toBeDefined();
  expect(groups).toHaveBeenCalledTimes(1);
  expect(f.resolve()).toBe(first);
  const broken = {
    ...f.input,
    resources: { texture: () => err(failure) },
  } as unknown as Parameters<typeof resolveTargetBindings>[0];
  expect(() => resolveTargetBindings(broken)).toThrow(failure);
});

it('observes current atmosphere and shadow resources and separates their absence', async () => {
  const f = await fixture();
  const withoutAtmosphere = f.resolve();
  const color = f.device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: 0x04,
      textureBindingViewDimension: '2d',
    })
    .unwrap();
  const volume = f.device
    .createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      dimension: '3d',
      format: 'rgba8unorm',
      usage: 0x04,
      textureBindingViewDimension: '3d',
    })
    .unwrap();
  const white = f.device.createTextureView(color, {}).unwrap();
  const sampler = f.device.createSampler({ compare: 'greater-equal' }).unwrap();
  Object.assign(f.state, {
    atmosphereAvailable: true,
    defaultWhiteTextureView: white,
    atmosphereFallbackView: f.device.createTextureView(volume, {}).unwrap(),
    shadowArrayFallbackTextureView: f.state.shadowFallbackTextureView,
    perPassResources: { shadowSampler: sampler },
    viewLinearSampler: sampler,
    defaultSampler: sampler,
  });
  const withAtmosphere = f.resolve();
  const groups = vi.spyOn(f.device, 'createBindGroup');
  const previousBuffer = f.state.viewUniformBuffer;
  f.state.viewUniformBuffer = f.device.createBuffer({ size: 16384, usage: 0x40 | 0x08 }).unwrap();
  f.resolve();
  expect(
    Array.from(groups.mock.calls[0]?.[0].entries ?? [])
      .map((entry) => entry.binding)
      .sort((a, b) => a - b),
  ).toEqual(
    viewAndSceneDepthLayoutEntries(true)
      .map((entry) => entry.binding)
      .sort((a, b) => a - b),
  );
  f.state.viewUniformBuffer = previousBuffer;
  expect(withAtmosphere).not.toBe(withoutAtmosphere);
  expect(f.resolve()).toBe(withAtmosphere);
  const shadow = f.device.createTextureView(f.makeDepth(), {}).unwrap();
  Object.assign(f.frame.frameState.frameOutputs, { directionalShadowView: shadow });
  const changedShadow = f.resolve();
  expect(changedShadow).not.toBe(withAtmosphere);
  Object.assign(f.frame.frameState.frameOutputs, { directionalShadowView: undefined });
  expect(f.resolve()).toBe(withAtmosphere);
  f.state.atmosphereAvailable = false;
  expect(f.resolve()).toBe(withoutAtmosphere);
});

it('retries a bind-group failure without retaining its partial depth view', async () => {
  const f = await fixture();
  const failure = new Error('bind group unavailable');
  vi.spyOn(f.device, 'createBindGroup').mockImplementationOnce(() => err(failure as never));
  const views = vi.spyOn(f.device, 'createTextureView');
  expect(() => f.resolve()).toThrow(failure);
  const accepted = f.resolve();
  expect(accepted).toBeDefined();
  expect(views).toHaveBeenCalledTimes(2);
  expect(f.resolve()).toBe(accepted);
  expect(views).toHaveBeenCalledTimes(2);
});

it('preserves a depth-view failure when the current pipeline has no usable layout', async () => {
  const f = await fixture();
  Object.assign(f.pipeline, { getBindGroupLayout: () => undefined });
  const failure = new Error('depth view unavailable before layout');
  const create = vi
    .spyOn(f.device, 'createTextureView')
    .mockImplementationOnce(() => err(failure as never));
  expect(() => f.resolve()).toThrow(failure);
  expect(f.resolve()).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(2);
  expect(f.frame.bindGroupCounts.createBindGroup).toBe(0);
});

it('reuses Standard VFX depth views and groups while observing physical resource replacement', async () => {
  const f = await fixture();
  const sampler = f.device.createSampler({ compare: 'greater-equal' }).unwrap();
  Object.assign(f.state, {
    perPassResources: { shadowSampler: sampler },
    shadowArrayFallbackTextureView: f.state.shadowFallbackTextureView,
    shadowAtlasFallbackTextureView: f.state.shadowFallbackTextureView,
    shadowParamsBuffer: f.buffer,
    shadowCasterCascadeBuffer: f.buffer,
    defaultWhiteTextureView: f.state.shadowFallbackTextureView,
    defaultSampler: sampler,
    extendedLightingAvailable: false,
    projectorAvailable: false,
  });
  Object.assign(f.input.binding, {
    bindingContract: 'render-standard-material-and-scene-depth',
    descriptor: { values: { sceneDepth: 'depth' } },
  });
  const groups = vi.spyOn(f.device, 'createBindGroup');
  const views = vi.spyOn(f.device, 'createTextureView');
  const resolve = () => {
    const result = f.resolve();
    if (result === undefined || !('handle' in result))
      throw new Error('Missing Standard View bindings');
    return result;
  };
  const first = resolve();
  expect(first).toMatchObject({ handle: expect.anything(), dynamicOffsets: [0, 0] });
  f.device.queue.writeBuffer(f.buffer, 0, new Float32Array([1, 2, 3, 4])).unwrap();
  expect(resolve().handle).toBe(first?.handle);
  expect(groups).toHaveBeenCalledTimes(1);
  expect(views).toHaveBeenCalledTimes(1);
  Object.assign(f.input.binding, { fogComposition: 'additive' });
  expect(resolve()).toMatchObject({
    handle: first?.handle,
    dynamicOffsets: [translucentViewOffset('additive'), 0],
  });
  f.setDepth(f.makeDepth());
  const replacement = resolve();
  expect(replacement?.handle).not.toBe(first?.handle);
  expect(views).toHaveBeenCalledTimes(2);
  Object.assign(f.frame.frameState.frameOutputs, {
    directionalShadowView: f.state.shadowFallbackTextureView,
  });
  // The initial fallback and this explicit graph view are physically equal.
  expect(resolve().handle).toBe(replacement?.handle);
  Object.assign(f.frame.frameState.frameOutputs, {
    directionalShadowView: f.device
      .createTextureView(f.makeDepth(), { aspect: 'depth-only' })
      .unwrap(),
  });
  expect(resolve().handle).not.toBe(replacement?.handle);
  const afterShadow = views.mock.calls.length;
  expect(resolve().handle).toBe(resolve().handle);
  expect(views.mock.calls.length).toBe(afterShadow);
});
