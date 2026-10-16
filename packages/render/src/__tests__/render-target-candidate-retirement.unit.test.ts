import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import type { RenderTargetDescriptor } from '../targets/contracts';

const descriptor: RenderTargetDescriptor = {
  shape: 'cube',
  width: 8,
  height: 8,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  depth: 'depth32float',
  sampled: true,
  readback: false,
};

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let finish!: () => void;
  const fence = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
  const destroyed = vi.spyOn(device, 'destroyTexture');
  const host = createRenderTargetHost({ getDevice: () => device });
  const created = host.createRenderTarget(descriptor);
  if (!created.ok) throw created.error;
  const target = created.value;
  host.beginFrame();
  const previous = host.getPhysicalTarget(target);
  if (previous === undefined) throw new Error('Missing candidate');
  return { device, host, target, previous, destroyed, finish, fence };
}

describe('RenderTarget candidate retirement', () => {
  it('retires every replaced pending cube only after the queue fence', async () => {
    const f = await fixture();
    expect(f.host.resizeRenderTarget(f.target, { ...descriptor, width: 16, height: 16 }).ok).toBe(
      true,
    );
    const second = f.host.getPhysicalTarget(f.target);
    if (second === undefined) throw new Error('Missing second candidate');
    expect(f.host.resizeRenderTarget(f.target, { ...descriptor, width: 32, height: 32 }).ok).toBe(
      true,
    );
    expect(f.destroyed).not.toHaveBeenCalled();
    f.finish();
    await f.fence;
    for (const old of [f.previous, second]) {
      for (const texture of [old.texture, old.depthTexture])
        expect(f.destroyed.mock.calls.filter(([value]) => value === texture)).toHaveLength(1);
    }
    f.host.dispose();
  });

  it('clears rejected pending storage, retires it after the fence and retries', async () => {
    const f = await fixture();
    vi.spyOn(f.device, 'createTexture').mockReturnValueOnce(
      err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'injected allocation failure',
          hint: 'retry the candidate',
        }),
      ),
    );
    expect(f.host.resizeRenderTarget(f.target, { ...descriptor, width: 16, height: 16 }).ok).toBe(
      false,
    );
    expect(f.host.getPhysicalTarget(f.target)).toBeUndefined();
    expect(f.destroyed).not.toHaveBeenCalled();
    f.host.beginFrame();
    expect(f.host.getPhysicalTarget(f.target)).toBeDefined();
    expect(f.host.getPhysicalTarget(f.target)).not.toBe(f.previous);
    f.finish();
    await f.fence;
    for (const texture of [f.previous.texture, f.previous.depthTexture])
      expect(f.destroyed.mock.calls.filter(([value]) => value === texture)).toHaveLength(1);
    f.host.dispose();
  });
  it('retries allocation failure after recovering a previously active target', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    let generation = 0;
    const host = createRenderTargetHost({
      getDevice: () => device,
      getGeneration: () => generation,
    });
    const created = host.createRenderTarget(descriptor);
    if (!created.ok) throw created.error;
    host.beginFrame();
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    await Promise.resolve();
    generation = 1;
    host.recover();
    vi.spyOn(device, 'createTexture').mockReturnValueOnce(
      err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'injected recovery allocation failure',
          hint: 'retry',
        }),
      ),
    );
    host.beginFrame();
    expect(host.getPhysicalTarget(created.value)).toBeUndefined();
    host.beginFrame();
    expect(host.getPhysicalTarget(created.value)?.generation).toBe(1);
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    await Promise.resolve();
    const later = host.createRenderTarget(descriptor);
    if (!later.ok) throw later.error;
    const source = host.createRenderTargetTextureSource(later.value, {
      aspect: 'color',
      dimension: 'cube',
      mipLevel: 0,
    });
    if (!source.ok) throw source.error;
    host.beginFrame();
    expect(host.getPhysicalTarget(later.value)?.generation).toBe(1);
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    await Promise.resolve();
    expect(host.resolveRenderTargetTextureSource(source.value)?.textureView).toBeDefined();
    host.dispose();
  });
});
