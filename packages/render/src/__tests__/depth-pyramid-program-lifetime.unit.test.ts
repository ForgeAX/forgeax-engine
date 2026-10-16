import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { makeShaderDeviceAdapter } from '../assembly/material-shader-policy';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { createDepthPyramidProgramResolver } from '../depth-pyramid/programs';
import { DeviceScope } from '../device/device-scope';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';

const sources = {
  seed: '@compute @workgroup_size(8,8) fn depth_pyramid_seed() {}\n@compute @workgroup_size(8,8) fn depth_pyramid_seed_furthest() {}\n@compute @workgroup_size(8,8) fn depth_pyramid_seed_furthest_multisampled() {}',
  reduce:
    '@compute @workgroup_size(8,8) fn depth_pyramid_reduce() {}\n@compute @workgroup_size(8,8) fn depth_pyramid_reduce_furthest() {}',
};

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const nativeModule = vi.fn((d: RhiDevice, value: { code: string; label?: string | undefined }) =>
    rhi.createShaderModuleImmediate(d, value),
  );
  const factory = makeShaderDeviceAdapter(
    device,
    {} as never,
    undefined,
    nativeModule,
    'immediate',
  );
  vi.spyOn(factory, 'createShaderModule');
  const scope = DeviceScope.create(0, 'depth-pyramid-test');
  const pipeline = vi.spyOn(device, 'createComputePipeline');
  const layouts = vi.spyOn(device, 'createBindGroupLayout');
  const groups = vi.spyOn(device, 'createBindGroup');
  return { device, factory, scope, pipeline, layouts, groups, nativeModule };
}

async function executePyramidGraph(
  device: RhiDevice,
  runtime: object,
  width: number,
  height: number,
  shaderSources = sources,
) {
  type Frame = { encoder: RhiCommandEncoder };
  const graph = new RenderGraphBuilder<Frame>();
  const depth = device
    .createTexture({
      size: { width, height },
      format: 'depth32float',
      usage: 4 | 16,
      textureBindingViewDimension: '2d',
    })
    .unwrap();
  const depthView = device
    .createTextureView(depth, { dimension: '2d', aspect: 'depth-only' })
    .unwrap();
  const uniform = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 64 | 8 }).unwrap();
  const imported = graph
    .importTexture(
      'depth',
      { format: 'depth32float', size: { width, height }, usage: 4 | 16 },
      () => depth,
    )
    .unwrap();
  const sampled = graph
    .importView(imported, { dimension: '2d', aspect: 'depth-only' }, () => depthView)
    .unwrap();
  const view = graph
    .importBuffer('view', { size: VIEW_UNIFORM_BYTES, usage: 64 | 8 }, () => uniform)
    .unwrap();
  const projection = addDepthPyramidPasses(graph, {
    depth: sampled,
    view,
    width,
    height,
    reduction: 'furthest',
  }).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width, height } }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    compiled
      .execute({
        encoder,
        runtime,
        depthPyramidShaders: shaderSources,
        bindGroupCounts: { createBindGroup: 0, keys: [] },
      } as Frame)
      .unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    return { depthView, uniform, plan: projection.pyramid.plan, inspection: compiled.inspect() };
  } finally {
    await compiled.retire();
    device.destroyTexture(depth).unwrap();
    device.destroyBuffer(uniform).unwrap();
  }
}

it('retains the two furthest programs across rebuilt graphs while binding each current view and UBO', async () => {
  const f = await fixture();
  const runtime = { device: f.device, deviceScope: f.scope, shaderModuleFactory: f.factory };
  const inputs = [];
  for (let i = 0; i < 6; i++)
    inputs.push(await executePyramidGraph(f.device, runtime, 16 + i * 8, 8 + i * 4));
  expect(f.pipeline).toHaveBeenCalledTimes(2);
  expect(f.layouts).toHaveBeenCalledTimes(2);
  expect(f.factory.createShaderModule).toHaveBeenCalledTimes(12);
  expect(f.nativeModule).toHaveBeenCalledTimes(2);
  expect(f.pipeline.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual([
    'depth_pyramid_seed_furthest',
    'depth_pyramid_reduce_furthest',
  ]);
  const seedGroups = f.groups.mock.calls
    .map(([d]) => Array.from(d.entries))
    .filter((entries) => entries.some((e) => e.binding === 2));
  expect(seedGroups).toHaveLength(inputs.length);
  for (const [index, input] of inputs.entries()) {
    expect(seedGroups[index]).toEqual(
      expect.arrayContaining([
        { binding: 0, resource: { kind: 'textureView', value: input.depthView } },
        {
          binding: 2,
          resource: { kind: 'buffer', value: { buffer: input.uniform, size: VIEW_UNIFORM_BYTES } },
        },
      ]),
    );
  }
  expect(f.scope.resourceDelta()).toBe(1);
  f.scope.dispose();
  expect(f.scope.resourceDelta()).toBe(0);
});

it('separates reduction/MSAA, exact source/layout, factory method and device generations', async () => {
  const f = await fixture(),
    other = await fixture();
  const get = createDepthPyramidProgramResolver();
  const runtime = { device: f.device, deviceScope: f.scope, shaderModuleFactory: f.factory };
  const frame = { runtime } as never;
  const entries = [{ binding: 0, visibility: 4, buffer: { type: 'uniform' } }];
  const first = get(frame, sources.seed, entries, 'seed');
  expect(createDepthPyramidProgramResolver()(frame, sources.seed, entries, 'seed')).toBe(first);
  for (const variant of [
    'seed_furthest',
    'seed_furthest_multisampled',
    'reduce',
    'reduce_furthest',
  ] as const)
    expect(
      get(frame, variant.startsWith('seed') ? sources.seed : sources.reduce, entries, variant),
    ).not.toBe(first);
  expect(f.pipeline).toHaveBeenCalledTimes(5);
  const revisedLayout = [{ ...entries[0], binding: 1 }];
  expect(get(frame, sources.seed, revisedLayout, 'seed')).not.toBe(first);
  const revisedSource = `${sources.seed}\n// revised`;
  get(frame, revisedSource, revisedLayout, 'seed');
  const originalMethod = f.factory.createShaderModule;
  f.factory.createShaderModule = vi.fn((d) => originalMethod(d));
  get(frame, revisedSource, revisedLayout, 'seed');
  runtime.shaderModuleFactory = {
    ...f.factory,
    createShaderModule: vi.fn((d) => originalMethod(d)),
  };
  get(frame, revisedSource, revisedLayout, 'seed');
  expect(f.pipeline).toHaveBeenCalledTimes(9);
  expect(() =>
    get({ runtime: { ...runtime, device: other.device } } as never, revisedSource, entries, 'seed'),
  ).toThrow('depth pyramid current device');
  const failure = new RhiError({
    code: 'rhi-not-available',
    expected: 'test pipeline failure',
    hint: 'retry',
  });
  f.pipeline.mockImplementationOnce(() => err(failure));
  expect(() => get(frame, `${revisedSource}\n`, entries, 'seed')).toThrow(failure);
  const retried = get(frame, `${revisedSource}\n`, entries, 'seed');
  expect(get(frame, `${revisedSource}\n`, entries, 'seed')).toBe(retried);
  expect(f.pipeline).toHaveBeenCalledTimes(11);
  f.scope.dispose();
  expect(() => get(frame, revisedSource, entries, 'seed')).toThrow(
    'depth pyramid live device scope',
  );
  const recovered = { ...runtime, deviceScope: DeviceScope.create(1, 'depth-pyramid-test') };
  expect(get({ runtime: recovered } as never, revisedSource, entries, 'seed')).not.toBe(retried);
  expect(f.pipeline).toHaveBeenCalledTimes(12);
  recovered.deviceScope.dispose();
  other.scope.dispose();
});

it('keeps scope-less graph adapters local rather than sharing them by device alone', async () => {
  const f = await fixture();
  const frame = { runtime: { device: f.device, shaderModuleFactory: f.factory } } as never;
  const one = createDepthPyramidProgramResolver(),
    two = createDepthPyramidProgramResolver();
  const a = one(frame, sources.seed, [], 'seed');
  expect(one(frame, sources.seed, [], 'seed')).toBe(a);
  expect(two(frame, sources.seed, [], 'seed')).not.toBe(a);
  expect(f.pipeline).toHaveBeenCalledTimes(2);
  expect(f.scope.resourceDelta()).toBe(0);
});

it('honors pending errors and actual module replacement behind an unchanged factory/source', async () => {
  const f = await fixture(),
    get = createDepthPyramidProgramResolver();
  const frame = {
    runtime: { device: f.device, deviceScope: f.scope, shaderModuleFactory: f.factory },
  } as never;
  const first = get(frame, sources.seed, [], 'seed');
  const pending = new RhiError({
    code: 'rhi-not-available',
    expected: 'module still pending',
    hint: 'retry',
  });
  vi.mocked(f.factory.createShaderModule).mockReturnValueOnce(err(pending));
  expect(() => get(frame, sources.seed, [], 'seed')).toThrow(pending);
  expect(f.pipeline).toHaveBeenCalledTimes(1);
  f.factory.invalidateModule('depth_pyramid_seed');
  const replacement = get(frame, sources.seed, [], 'seed');
  expect(replacement).not.toBe(first);
  expect(f.pipeline).toHaveBeenCalledTimes(2);
  expect(get(frame, sources.seed, [], 'seed')).toBe(replacement);
  f.scope.dispose();
});
