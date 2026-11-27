import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { NativeDevice } from '../binding';
import { GPUPipelineError, NativeGPUDevice } from '../gpu';
import { NativeGPUObject, NativeGPUShaderModule } from '../objects';

function fixture() {
  const complete: ((value: unknown) => void)[] = [];
  const native = {
    features: () => [],
    limits: () => '{}',
    lostInfo: () => null,
    drainErrors: () => '[]',
    destroy: vi.fn(),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => 'null'),
    createComputePipeline: vi.fn(() => {
      throw new Error('sync entry reached');
    }),
    createComputePipelineAsync: vi.fn(
      (_descriptor: string) =>
        new Promise<unknown>((resolve) => {
          complete.push(resolve);
        }),
    ),
    adoptComputePipeline: vi.fn((value: unknown) => value as { id: number }),
  };
  const device = new NativeGPUDevice(
    native as unknown as NativeDevice,
    {} as GPUAdapterInfo,
    undefined,
  );
  const descriptor = {
    label: 'compute',
    layout: 'auto',
    compute: {
      module: new NativeGPUShaderModule(device, 5, undefined, []),
      entryPoint: 'main',
      constants: { N: 3 },
    },
  } as unknown as GPUComputePipelineDescriptor;
  return { native, device, descriptor, complete };
}

it('returns a pending promise without entering synchronous native compilation or holding scopes', async () => {
  const f = fixture();
  const pending = f.device.createComputePipelineAsync(f.descriptor);
  const settled = vi.fn();
  void pending.then(settled, settled);
  await setImmediate();
  expect(f.native.createComputePipeline).not.toHaveBeenCalled();
  expect(f.native.createComputePipelineAsync).toHaveBeenCalledTimes(1);
  expect(f.native.pushErrorScope).not.toHaveBeenCalled();
  expect(f.native.popErrorScope).not.toHaveBeenCalled();
  expect(settled).not.toHaveBeenCalled();
  expect(JSON.parse(f.native.createComputePipelineAsync.mock.calls[0]?.[0] ?? '')).toEqual({
    label: 'compute',
    layout: null,
    compute: { module: 5, entryPoint: 'main', constants: { N: 3 } },
  });
  f.complete[0]?.({ id: 9 });
  expect((await pending).nativeId).toBe(9);
});

it.each([
  'validation',
  'internal',
] as const)('preserves a worker %s pipeline error', async (kind) => {
  const f = fixture();
  const pending = f.device.createComputePipelineAsync(f.descriptor);
  f.complete[0]?.({ id: 0, error: { kind, message: 'controlled failure' } });
  await expect(pending).rejects.toMatchObject({
    name: 'GPUPipelineError',
    reason: kind,
    message: 'controlled failure',
  });
});

it('does not adopt a completion after device destruction', async () => {
  const f = fixture();
  const pending = f.device.createComputePipelineAsync(f.descriptor);
  f.device.destroy();
  f.complete[0]?.({ id: 9 });
  await expect(pending).rejects.toBeInstanceOf(GPUPipelineError);
  expect(f.native.adoptComputePipeline).not.toHaveBeenCalled();
});

it('keeps concurrent equal descriptors and reversed completions independent', async () => {
  const f = fixture();
  const first = f.device.createComputePipelineAsync(f.descriptor);
  const second = f.device.createComputePipelineAsync(f.descriptor);
  f.complete[1]?.({ id: 22 });
  expect((await second).nativeId).toBe(22);
  f.complete[0]?.({ id: 11 });
  expect((await first).nativeId).toBe(11);
  expect(f.native.pushErrorScope).not.toHaveBeenCalled();
});

it('maps a worker transport failure to an internal pipeline error', async () => {
  const f = fixture();
  f.native.createComputePipelineAsync.mockRejectedValueOnce(new Error('worker unavailable'));
  await expect(f.device.createComputePipelineAsync(f.descriptor)).rejects.toMatchObject({
    name: 'GPUPipelineError',
    reason: 'internal',
    message: 'worker unavailable',
  });
});

it('rejects foreign module and layout identities before worker submission even when ids collide', async () => {
  const f = fixture();
  const other = fixture();
  for (const descriptor of [
    { ...f.descriptor, compute: other.descriptor.compute },
    { ...f.descriptor, layout: new NativeGPUObject(other.device, 5, undefined) },
  ]) {
    await expect(
      f.device.createComputePipelineAsync(descriptor as GPUComputePipelineDescriptor),
    ).rejects.toMatchObject({ reason: 'validation' });
  }
  expect(f.native.createComputePipelineAsync).not.toHaveBeenCalled();
});

it('snapshots constants and label before the caller changes the descriptor', async () => {
  const f = fixture();
  const descriptor = { ...f.descriptor, compute: { ...f.descriptor.compute, constants: { N: 3 } } };
  const pending = f.device.createComputePipelineAsync(descriptor);
  descriptor.label = 'changed';
  descriptor.compute.constants.N = 4;
  expect(
    JSON.parse(f.native.createComputePipelineAsync.mock.calls[0]?.[0] ?? '').compute.constants,
  ).toEqual({ N: 3 });
  f.complete[0]?.({ id: 9 });
  expect((await pending).label).toBe('compute');
});

it('rejects a destroyed device before sending work and rejects an invalid adopted handle', async () => {
  const f = fixture();
  f.device.destroy();
  await expect(f.device.createComputePipelineAsync(f.descriptor)).rejects.toMatchObject({
    reason: 'internal',
  });
  expect(f.native.createComputePipelineAsync).not.toHaveBeenCalled();
  const live = fixture();
  const pending = live.device.createComputePipelineAsync(live.descriptor);
  live.complete[0]?.({ id: 0, error: null });
  await expect(pending).rejects.toMatchObject({ reason: 'internal' });
});
