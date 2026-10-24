import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { buildFullscreenPostProcessPass } from '../fullscreen-post-process-pass';

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
  expect(layouts).toHaveBeenCalledTimes(1);
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
