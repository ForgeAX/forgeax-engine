import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import { RenderTargetOperationFailedError } from '../errors/render';
import type { RenderTargetDescriptor } from '../targets/contracts';
import { createRenderTargetPhysical, retireRenderTargetPhysical } from '../targets/physical';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 8,
  height: 8,
  format: 'rgba8unorm',
  sampleCount: 1,
  mipLevels: 1,
  sampled: true,
  readback: true,
};
const failure = () =>
  new RhiError({
    code: 'rhi-not-available',
    expected: 'injected retirement failure',
    hint: 'recover',
  });
async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const onError = vi.fn();
  let generation = 0;
  const options = { getDevice: () => device, getGeneration: () => generation, onError };
  const host = createRenderTargetHost(options);
  const create = () => {
    const target = host.createRenderTarget(descriptor);
    if (!target.ok) throw target.error;
    const source = host.createRenderTargetTextureSource(target.value, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
    });
    if (!source.ok) throw source.error;
    return { target: target.value, source: source.value };
  };
  const submit = async () => {
    host.beginFrame();
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    await Promise.resolve();
  };
  return {
    device,
    host,
    onError,
    create,
    submit,
    advanceGeneration: () => {
      generation++;
    },
  };
}

describe('target retirement error boundaries', () => {
  it.each([
    'result',
    'throw',
  ])('public destroy returns structured %s failure after clearing both storages and readbacks', async (mode) => {
    const f = await fixture();
    const { target } = f.create();
    await f.submit();
    expect(f.host.requestTargetReadback(target, { mipLevel: 0 }).ok).toBe(true);
    expect(f.host.resizeRenderTarget(target, { ...descriptor, width: 16 }).ok).toBe(true);
    const textures = vi.spyOn(f.device, 'destroyTexture');
    if (mode === 'result') textures.mockReturnValueOnce(err(failure()));
    else
      textures.mockImplementationOnce(() => {
        throw failure();
      });
    const buffers = vi.spyOn(f.device, 'destroyBuffer');
    let result: ReturnType<typeof f.host.destroyRenderTarget> | undefined;
    expect(() => {
      result = f.host.destroyRenderTarget(target);
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, error: { code: 'render-target-operation-failed' } });
    expect(textures).toHaveBeenCalledTimes(4);
    expect(buffers).toHaveBeenCalledTimes(1);
    expect(f.host.getPhysicalTarget(target)).toBeUndefined();
    expect(f.host.descriptions()).toEqual([]);
    expect(() => f.host.dispose()).not.toThrow();
  });

  it.each([
    'result',
    'rejection',
  ])('ignores unrelated frame completion %s with no submitted target work', async (mode) => {
    const f = await fixture();
    const held = f.create();
    await f.submit();
    const previous = f.host.resolveRenderTargetTextureSource(held.source)?.textureView;
    const error = new RenderTargetOperationFailedError({
      operation: 'create',
      stage: 'submit',
      generation: 0,
      cause: failure(),
      recovery: 'retain-last-known-good',
    });
    f.host.onFrameSubmitted(
      mode === 'result' ? Promise.resolve(err(error)) : Promise.reject(error),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.host.resolveRenderTargetTextureSource(held.source)?.textureView).toBe(previous);
    f.host.dispose();
  });

  it('reports old storage failures and still promotes every sibling at completion', async () => {
    const f = await fixture();
    const a = f.create(),
      b = f.create();
    await f.submit();
    for (const { target } of [a, b])
      expect(f.host.resizeRenderTarget(target, { ...descriptor, width: 16 }).ok).toBe(true);
    const nextA = f.host.getPhysicalTarget(a.target),
      nextB = f.host.getPhysicalTarget(b.target);
    const destroyed = vi.spyOn(f.device, 'destroyTexture').mockReturnValueOnce(err(failure()));
    await f.submit();
    expect(destroyed).toHaveBeenCalledTimes(4);
    expect(f.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'render-target-operation-failed' }),
    );
    expect(f.host.resolveRenderTargetTextureSource(a.source)?.textureView).toBe(nextA?.mipViews[0]);
    expect(f.host.resolveRenderTargetTextureSource(b.source)?.textureView).toBe(nextB?.mipViews[0]);
    f.host.dispose();
  });

  it('reports rejected completion and drains both candidates without replacing accepted storage', async () => {
    const f = await fixture();
    const a = f.create(),
      b = f.create();
    await f.submit();
    const accepted = [a, b].map(
      ({ source }) => f.host.resolveRenderTargetTextureSource(source)?.textureView,
    );
    for (const { target } of [a, b])
      expect(f.host.resizeRenderTarget(target, { ...descriptor, width: 16 }).ok).toBe(true);
    const destroyed = vi.spyOn(f.device, 'destroyTexture').mockReturnValueOnce(err(failure()));
    for (const { target } of f.host.descriptions()) {
      const physical = f.host.getPhysicalTarget(target);
      if (physical !== undefined) f.host.markTargetSubmitted(target, physical);
    }
    f.host.onFrameSubmitted(Promise.reject(failure()));
    await Promise.resolve();
    await Promise.resolve();
    expect(destroyed).toHaveBeenCalledTimes(4);
    expect(f.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'render-target-operation-failed',
        detail: expect.objectContaining({ stage: 'submit' }),
      }),
    );
    expect(
      [a, b].map(({ source }) => f.host.resolveRenderTargetTextureSource(source)?.textureView),
    ).toEqual(accepted);
    f.host.dispose();
  });
  it.each([
    'recover',
    'dispose',
  ] as const)('%s drains sibling targets and readbacks after RHI errors', async (operation) => {
    const f = await fixture();
    const targets = [f.create(), f.create()];
    await f.submit();
    for (const { target } of targets)
      expect(f.host.requestTargetReadback(target, { mipLevel: 0 }).ok).toBe(true);
    const textures = vi.spyOn(f.device, 'destroyTexture').mockReturnValueOnce(err(failure()));
    const buffers = vi.spyOn(f.device, 'destroyBuffer').mockImplementationOnce(() => {
      throw failure();
    });
    f.advanceGeneration();
    expect(() => f.host[operation]()).not.toThrow();
    expect(textures).toHaveBeenCalledTimes(4);
    expect(buffers).toHaveBeenCalledTimes(2);
    expect(f.onError).toHaveBeenCalledTimes(2);
    for (const { target } of targets) expect(f.host.getPhysicalTarget(target)).toBeUndefined();
    if (operation === 'recover') {
      f.host.beginFrame();
      for (const { target } of targets)
        expect(f.host.getPhysicalTarget(target)?.generation).toBe(1);
    } else expect(f.host.descriptions()).toEqual([]);
    f.host.dispose();
  });

  it('reports replaced candidate retirement after its owning fence', async () => {
    const f = await fixture();
    const { target } = f.create();
    f.host.beginFrame();
    const textures = vi.spyOn(f.device, 'destroyTexture').mockReturnValueOnce(err(failure()));
    expect(f.host.resizeRenderTarget(target, { ...descriptor, width: 16 }).ok).toBe(true);
    await Promise.resolve();
    expect(textures).toHaveBeenCalledTimes(2);
    expect(f.onError).toHaveBeenCalledTimes(1);
    f.host.dispose();
  });

  it.each([
    'fulfilled',
    'rejected',
    'throw',
  ] as const)('physical retirement reports failures after a %s fence without retaining the capture', async (mode) => {
    const f = await fixture();
    const source = createRenderTargetPhysical(f.device, descriptor, 0);
    if (!source.ok) throw source.error;
    const textures = vi.spyOn(f.device, 'destroyTexture').mockReturnValueOnce(err(failure()));
    if (mode === 'rejected')
      vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockRejectedValueOnce(failure());
    if (mode === 'throw')
      vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockImplementationOnce(() => {
        throw failure();
      });
    expect(() => retireRenderTargetPhysical(source.value, f.onError)).not.toThrow();
    await Promise.resolve();
    expect(textures).toHaveBeenCalledTimes(2);
    expect(f.onError).toHaveBeenCalled();
    f.host.dispose();
  });
});
