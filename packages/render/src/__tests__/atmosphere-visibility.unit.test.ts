import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { atmosphereVisibilityGroup } from '../environment/visibility';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';

it('binds a Beer shadow without float32 filtering and retains the Atmosphere fallback and samplers', async () => {
  const backing = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const caps = { ...backing.caps, float32Filterable: false };
  const createBindGroupLayout = vi.fn(backing.createBindGroupLayout.bind(backing));
  const createBindGroup = vi.fn(backing.createBindGroup.bind(backing));
  const device: RhiDevice = new Proxy(backing, {
    get(target, key) {
      if (key === 'caps') return caps;
      if (key === 'createBindGroupLayout') return createBindGroupLayout;
      if (key === 'createBindGroup') return createBindGroup;
      const member = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  const beer = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      usage: 0x14,
    })
    .unwrap();
  const beerView = device.createTextureView(beer, { dimension: '2d' }).unwrap();
  const white = device
    .createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x04,
    })
    .unwrap();
  const whiteView = device.createTextureView(white, { dimension: '2d' }).unwrap();
  const depth = device
    .createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 2 },
      format: 'depth32float',
      usage: 0x04,
    })
    .unwrap();
  const directionalView = device.createTextureView(depth, { dimension: '2d-array' }).unwrap();
  const comparison = device.createSampler({ compare: 'greater-equal' }).unwrap();
  const filtering = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
  const viewBuffer = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 0x40 }).unwrap();
  const frame = {
    runtime: { device },
    pipelineState: {
      perPassResources: { shadowSampler: comparison },
      shadowArrayFallbackTextureView: directionalView,
      defaultWhiteTextureView: whiteView,
      viewLinearSampler: filtering,
    },
  } as unknown as RenderPipelineFrame;

  expect(device.caps.float32Filterable).toBe(false);
  atmosphereVisibilityGroup(frame, viewBuffer, 0, directionalView, beerView);
  atmosphereVisibilityGroup(frame, viewBuffer, 0);
  expect(createBindGroupLayout).toHaveBeenCalledTimes(1);
  expect(createBindGroupLayout.mock.calls[0]?.[0].entries).toEqual(
    expect.arrayContaining([
      { binding: 0, visibility: 6, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      { binding: 1, visibility: 6, sampler: { type: 'comparison' } },
      {
        binding: 2,
        visibility: 6,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      { binding: 3, visibility: 6, sampler: { type: 'filtering' } },
    ]),
  );
  const groups = createBindGroup.mock.calls.map(([descriptor]) => descriptor);
  expect(groups).toHaveLength(2);
  expect(groups[0]?.layout).toBe(groups[1]?.layout);
  for (const [index, cloud] of [beerView, whiteView].entries()) {
    expect(groups[index]?.entries).toEqual(
      expect.arrayContaining([
        { binding: 0, resource: { kind: 'textureView', value: directionalView } },
        { binding: 1, resource: { kind: 'sampler', value: comparison } },
        { binding: 2, resource: { kind: 'textureView', value: cloud } },
        { binding: 3, resource: { kind: 'sampler', value: filtering } },
      ]),
    );
  }
});
