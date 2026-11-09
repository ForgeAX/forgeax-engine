import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { rendererDeviceAdmission } from '../assembly/device-feature-admission';
import { acquireDeviceGeneration } from '../assembly/recovery/recovery-attempt';
import { tryCreateRendererFromBackend } from '../assembly/webgpu-renderer-bootstrap';

it('retires a rejected device before startup or recovery claims the canvas', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const original = (await adapter.requestDevice()).unwrap();
  expect(rendererDeviceAdmission(original)).toBeUndefined();
  const device = Object.create(original) as RhiDevice;
  Object.defineProperty(device, 'caps', { value: { ...original.caps, depthTextureLoad: false } });
  const acquireCanvasContext = vi.fn(() => {
    throw new Error('Rejected device claimed the canvas');
  });
  const disposeDevice = vi.fn();
  const create = vi.fn(() => {
    throw new Error('Rejected device compiled stock shaders');
  });
  const pack = {
    rhi: {
      async requestAdapter() {
        return ok({ ...adapter, requestDevice: async () => ok(device) });
      },
      acquireCanvasContext,
    },
    disposeDevice,
  };
  const result = await tryCreateRendererFromBackend(
    {} as never,
    undefined,
    pack,
    undefined,
    create,
  );
  expect(result.kind).toBe('rhi-err');
  if (result.kind !== 'rhi-err') throw new Error('Restricted device was admitted');
  expect(result.error.code).toBe('feature-not-enabled');
  expect(result.error.expected).toContain('caps.depthTextureLoad');
  expect(disposeDevice).toHaveBeenCalledExactlyOnceWith(device);
  expect(acquireCanvasContext).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();

  disposeDevice.mockClear();
  const recovered = await acquireDeviceGeneration(pack, {} as HTMLCanvasElement);
  expect(recovered.ok).toBe(false);
  if (recovered.ok) throw new Error('Recovery admitted a restricted device');
  expect(recovered.error.stage).toBe('device');
  expect(recovered.error.error.code).toBe('feature-not-enabled');
  expect(disposeDevice).toHaveBeenCalledExactlyOnceWith(device);
  expect(acquireCanvasContext).not.toHaveBeenCalled();
});
