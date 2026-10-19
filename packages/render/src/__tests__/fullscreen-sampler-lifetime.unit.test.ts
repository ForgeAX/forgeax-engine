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
