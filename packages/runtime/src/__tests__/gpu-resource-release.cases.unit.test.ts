import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { GpuBuffer } from '../../../render/src/gpu-resource';
import {
  disposeInstanceBuffers,
  type InstanceBufferCacheEntry,
} from '../../../render/src/instance-buffer-cache';
import {
  CPU_SETUP_SHADER,
  cpuSetupFixture,
} from '../../../render/src/record/__tests__/main-pass-cpu-setup-fixture';
import { cleanPerFrameCaches } from '../../../render/src/record/fold-buckets';

it.each([
  'dispose',
  'retire',
] as const)('continues %s after a destroy failure and removes pre-destroyed entries once', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const entry = (): InstanceBufferCacheEntry => ({
    buffer: new GpuBuffer(device, device.createBuffer({ size: 16, usage: 8 }).unwrap()),
    uploadedArchVersion: 1,
    uploadedByteLength: 16,
  });
  const first = entry(),
    failed = entry(),
    last = entry();
  first.buffer.destroy().unwrap();
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'destroy succeeds',
    hint: 'injected failure',
  });
  const destroy = vi.spyOn(device, 'destroyBuffer').mockReturnValueOnce(err(failure));
  const fire = vi.fn();
  const instanceBuffers = new Map([
    [1, first],
    [2, failed],
    [3, last],
  ]);
  const clean = () =>
    mode === 'dispose'
      ? disposeInstanceBuffers(instanceBuffers, { fire })
      : cleanPerFrameCaches(
          { errorRegistry: { fire } } as never,
          {
            instanceBuffers,
            materialBgPerEntity: new Map(),
            instancesBgPerEntity: new Map(),
          } as never,
          [],
        );
  clean();
  expect(instanceBuffers.size).toBe(0);
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(destroy).not.toHaveBeenCalledWith(first.buffer.handle);
  expect(last.buffer.isDestroyed).toBe(true);
  expect(fire).toHaveBeenCalledExactlyOnceWith(failure);
  clean();
  expect(destroy).toHaveBeenCalledTimes(2);
  destroy.mockRestore();
  failed.buffer.destroy().unwrap();
});

it('replaces changed instance storage through the actual record owner even when old-buffer destruction fails', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const fixture = cpuSetupFixture(device, module);
  const row = fixture.add({ entity: 1, instances: 2, submeshes: 1 });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    fixture.record(pass);
    const old = [...fixture.c.frameState.instanceBuffers.values()][0];
    expect(old).toBeDefined();
    if (!old) throw Error('expected resident instance storage');
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'destroy succeeds',
      hint: 'injected failure',
    });
    const destroy = vi.spyOn(device, 'destroyBuffer').mockReturnValueOnce(err(failure));
    assert(row.source.instances);
    Reflect.set(row.source.instances, 'archVersion', 2);
    fixture.record(pass);
    const current = [...fixture.c.frameState.instanceBuffers.values()][0];
    expect(current?.buffer).not.toBe(old.buffer);
    expect(current?.uploadedArchVersion).toBe(2);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(old.buffer.handle);
    expect(fixture.errors).toEqual([failure]);
    destroy.mockRestore();
    old.buffer.destroy().unwrap();
  } finally {
    pass.end();
    fixture.dispose();
  }
});
