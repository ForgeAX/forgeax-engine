import { err, RhiError, type RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { buildFullscreenPostProcessPass } from '../fullscreen-post-process-pass';
import { SINGLE_LAYER_MEDIUM_MSAA_SURFACE_PROGRAMS } from '../pipeline/single-layer-medium-passes';

it('binds the reserved empty group before fullscreen draws and preserves View bindings', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const groups = vi.spyOn(device, 'createBindGroup');
  const context = {
    device,
    errorRegistry: {
      fire: (error: RhiError) => {
        throw error;
      },
    },
  };
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
  };
  for (const source of ['output-transform', 'standard-tone']) {
    const built = buildFullscreenPostProcessPass(context, { source });
    if (built === null) throw new Error('fullscreen pass was not built');
    const handle = built.createHandle(source, {}, null);
    handle.draw(pass as unknown as RhiRenderPassEncoder, {} as never);
  }
  expect(groups).toHaveBeenCalledTimes(1);
  expect(groups.mock.calls[0]?.[0].entries).toEqual([]);
  expect(pass.setBindGroup).toHaveBeenCalledTimes(2);
  expect(pass.setBindGroup.mock.calls[0]?.[0]).toBe(0);
  expect(pass.setBindGroup.mock.calls[1]?.[1]).toBe(pass.setBindGroup.mock.calls[0]?.[1]);
  expect(pass.setBindGroup.mock.invocationCallOrder[0]).toBeLessThan(
    pass.draw.mock.invocationCallOrder[0] ?? Number.NaN,
  );
  const view = buildFullscreenPostProcessPass(context, { source: 'view-effect', usesView: true });
  if (view === null) throw new Error('View fullscreen pass was not built');
  view
    .createHandle('view-effect', {}, null)
    .draw(pass as unknown as RhiRenderPassEncoder, {} as never);
  expect(pass.setBindGroup).toHaveBeenCalledTimes(2);
  const nextDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const next = buildFullscreenPostProcessPass(
    { ...context, device: nextDevice },
    { source: 'output-transform' },
  );
  if (next === null) throw new Error('fullscreen pass was not rebuilt for the new device');
  next
    .createHandle('output-transform', {}, null)
    .draw(pass as unknown as RhiRenderPassEncoder, {} as never);
  expect(pass.setBindGroup.mock.calls[2]?.[1]).not.toBe(pass.setBindGroup.mock.calls[0]?.[1]);
});

it('declares explicit FP32 meter reads without changing ordinary color sampling', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const layouts = vi.spyOn(device, 'createBindGroupLayout');
  buildFullscreenPostProcessPass(
    {
      device,
      errorRegistry: {
        fire: (error) => {
          throw error;
        },
      },
    },
    { source: '', reads: ['color', { key: 'meters', sampleType: 'unfilterable-float' }] },
  );
  const entries = layouts.mock.calls.flatMap(([descriptor]) => Array.from(descriptor.entries));
  expect(entries.find((entry) => entry.binding === 2)?.texture?.sampleType).toBe(
    'unfilterable-float',
  );
  expect(entries.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe('float');
});

it('shares fixed sampler semantics across declarations while isolating device generations', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = vi.spyOn(device, 'createSampler');
  const context = {
    device,
    errorRegistry: {
      fire: (error: RhiError) => {
        throw error;
      },
    },
  };
  const first = buildFullscreenPostProcessPass(context, { source: '' });
  const depth = buildFullscreenPostProcessPass(context, {
    source: '',
    reads: [{ key: 'scene-depth', sampleType: 'depth' }],
  });
  const replaced = buildFullscreenPostProcessPass(
    context,
    {
      source: 'changed',
      reads: ['color', { key: 'new-depth', sampleType: 'depth' }],
    },
    true,
  );
  expect(create.mock.calls.map(([descriptor]) => descriptor)).toEqual([
    {
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'linear',
      magFilter: 'linear',
    },
    {
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'nearest',
      magFilter: 'nearest',
    },
  ]);
  expect(first?.sampler).toBe(depth?.sampler);
  expect(replaced?.sampler).toBe(first?.sampler);
  expect(depth?.depthSampler).not.toBe(depth?.sampler);
  expect(replaced?.depthSampler).toBe(depth?.depthSampler);
  expect(replaced?.bindGroupLayout).not.toBe(depth?.bindGroupLayout);
  const nextDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const next = buildFullscreenPostProcessPass({ ...context, device: nextDevice }, { source: '' });
  expect(next?.sampler).not.toBe(first?.sampler);
});

it('retries failed sampler creation on the same device', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = vi.spyOn(device, 'createSampler');
  create.mockReturnValueOnce(
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'test device ready',
        hint: 'retry',
      }),
    ),
  );
  const context = {
    device,
    errorRegistry: {
      fire: (error: RhiError) => {
        throw error;
      },
    },
  };
  expect(buildFullscreenPostProcessPass(context, { source: '' })?.sampler).toBeNull();
  expect(buildFullscreenPostProcessPass(context, { source: '' })?.sampler).not.toBeNull();
  expect(create).toHaveBeenCalledTimes(2);
});

it('reuses one built fullscreen pass per device and declaration until its signature changes', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const layouts = vi.spyOn(device, 'createBindGroupLayout');
  const context = {
    device,
    errorRegistry: {
      fire: (error: RhiError) => {
        throw error;
      },
    },
  };
  const entry = {
    source: 'fn fs_main() {}',
    reads: ['color' as string | { key: string; sampleType?: 'depth' }],
  };
  const first = buildFullscreenPostProcessPass(context, entry);
  expect(buildFullscreenPostProcessPass(context, entry)).toBe(first);
  expect(layouts).toHaveBeenCalledTimes(2);
  // The multisampled-depth variant is a distinct layout of the same declaration.
  const multisampled = buildFullscreenPostProcessPass(context, entry, true);
  expect(multisampled).not.toBe(first);
  expect(buildFullscreenPostProcessPass(context, entry, true)).toBe(multisampled);
  // An in-place read edit changes the layout inputs and rebuilds.
  entry.reads.push({ key: 'scene-depth', sampleType: 'depth' });
  const withDepth = buildFullscreenPostProcessPass(context, entry);
  expect(withDepth).not.toBe(first);
  expect(withDepth?.depthSampler).not.toBeNull();
  const nextDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  expect(buildFullscreenPostProcessPass({ ...context, device: nextDevice }, entry)).not.toBe(
    withDepth,
  );
});

it('derives every matched-surface texture type from the registered fullscreen reads', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const layouts = vi.spyOn(device, 'createBindGroupLayout');
  const context = {
    device,
    errorRegistry: {
      fire: (error: RhiError) => {
        throw error;
      },
    },
  };
  const surface = SINGLE_LAYER_MEDIUM_MSAA_SURFACE_PROGRAMS[0];
  expect(
    buildFullscreenPostProcessPass(context, { source: '', reads: ['color', 'extra'] }),
  ).not.toBeNull();
  expect(layouts.mock.calls.at(-1)?.[0].entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        binding: 0,
        texture: { sampleType: 'float', viewDimension: '2d' },
      }),
      expect.objectContaining({
        binding: 2,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      }),
    ]),
  );
  if (surface === undefined) throw new Error('missing matched surface program');
  expect(buildFullscreenPostProcessPass(context, surface, true)).not.toBeNull();
  expect(layouts.mock.calls.at(-1)?.[0].entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        binding: 0,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: true },
      }),
      expect.objectContaining({
        binding: 3,
        texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true },
      }),
      expect.objectContaining({
        binding: 5,
        texture: { sampleType: 'uint', viewDimension: '2d', multisampled: true },
      }),
      expect.objectContaining({
        binding: 6,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: true },
      }),
    ]),
  );
  const gather = SINGLE_LAYER_MEDIUM_MSAA_SURFACE_PROGRAMS[2];
  if (gather === undefined) throw new Error('missing selected color program');
  expect(buildFullscreenPostProcessPass(context, gather)).not.toBeNull();
  expect(layouts.mock.calls.at(-1)?.[0].entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        binding: 0,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: true },
      }),
      expect.objectContaining({
        binding: 2,
        texture: { sampleType: 'uint', viewDimension: '2d', multisampled: false },
      }),
      expect.objectContaining({
        binding: 3,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: true },
      }),
    ]),
  );
});
