import type { RenderPipeline, RhiRenderPipelineOps } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import { resolveTargetBindings } from '../typed-frame-graph-bindings';

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
    binding: { kind: 'bindings', pipeline, descriptor },
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
