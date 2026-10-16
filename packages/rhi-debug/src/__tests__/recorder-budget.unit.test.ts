import type { RhiInstance } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { wrap } from '../recorder';
import { recorderDeviceIdentity } from '../recorder/core';
import { ResourceRegistry } from '../recorder/resource-registry';
import { attachRecorder, type RecordableBackend } from '../recorder/session';
import { snapshotFrame } from '../recorder/snapshot';

function backend(): RecordableBackend {
  return {
    rhi: {
      requestAdapter: vi.fn(() => Promise.resolve({ ok: false as const, error: {} })),
    } as unknown as RhiInstance,
    createShaderModule: vi.fn(),
  };
}

describe('RecorderSession bounded options', () => {
  it('fails before snapshot allocation when the byte budget is exhausted', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const capture = attached.value.captureFrame({ byteBudget: 0 });
    const boundary = await attached.value.frameBoundary();
    expect(boundary).toMatchObject({ ok: false, error: { code: 'capture-snapshot-failed' } });
    expect(await capture).toMatchObject({ ok: false, error: { code: 'capture-snapshot-failed' } });

    const retry = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    await attached.value.frameBoundary();
    expect((await retry).ok).toBe(true);
  });

  it('keeps timeout and budget as bounded options instead of frame-count controls', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const options = { snapshotTimeoutMs: 1, byteBudget: 1024 };
    const capture = attached.value.captureFrame(options);
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    await attached.value.frameBoundary();
    expect((await capture).ok).toBe(true);
  });
});

describe('snapshot byte accounting', () => {
  it('does not drain the GPU queue when every live seed is omitted', async () => {
    const recorder = wrap(rhi);
    const device = (await (await recorder.requestAdapter()).unwrap().requestDevice()).unwrap();
    device.createBuffer({ size: 64, usage: 0x0c }).unwrap();
    const realDevice = recorderDeviceIdentity(device) ?? device;
    const drain = vi.spyOn(realDevice.queue, 'onSubmittedWorkDone');
    recorder.arm(1).unwrap();
    expect((await recorder.snapshotAllLiveResources(100, 0)).ok).toBe(true);
    expect(drain).not.toHaveBeenCalled();
  });

  it('uses complete format, mip and layer bytes before any GPU readback', async () => {
    const recorder = wrap(rhi);
    const device = (await (await recorder.requestAdapter()).unwrap().requestDevice()).unwrap();
    device
      .createTexture({
        size: { width: 8, height: 8, depthOrArrayLayers: 2 },
        format: 'rgba16float',
        mipLevelCount: 3,
        usage: 4,
      })
      .unwrap();
    const registry = new ResourceRegistry(recorder);
    expect(registry.estimateSnapshotBytes()).toBe(1344);
    recorder.arm(1).unwrap();
    const readback = vi.spyOn(recorder, 'snapshotAllLiveResources');
    const result = await snapshotFrame(recorder, registry, {
      byteBudget: 1343,
      snapshotTimeoutMs: 1000,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'capture-snapshot-failed' } });
    expect(readback).not.toHaveBeenCalled();
    recorder.transitionToError();
    recorder.disposeError();
  });

  it('counts compressed blocks and excludes unseedable scratch and MSAA', async () => {
    const recorder = wrap(rhi);
    const device = (await (await recorder.requestAdapter()).unwrap().requestDevice()).unwrap();
    device
      .createTexture({
        size: { width: 8, height: 8, depthOrArrayLayers: 2 },
        format: 'bc1-rgba-unorm',
        mipLevelCount: 2,
        usage: 4,
      })
      .unwrap();
    device
      .createTexture({
        size: { width: 8, height: 8 },
        format: 'rgba8unorm',
        sampleCount: 4,
        usage: 16,
      })
      .unwrap();
    device
      .createTexture({ size: { width: 8, height: 8 }, format: 'depth24plus', usage: 16 })
      .unwrap();
    device.createBuffer({ size: 4096, usage: 9 }).unwrap();
    expect(new ResourceRegistry(recorder).estimateSnapshotBytes()).toBe(80);
  });
});
