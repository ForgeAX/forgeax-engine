import { expect, it } from 'vitest';
import { requestAdapterFrom } from '../index';
import { createMockGpu } from './__mocks__/gpu-device';

it('retains an unknown native requestDevice failure instead of inventing a missing feature', async () => {
  const gpu = createMockGpu();
  const raw = await gpu.requestAdapter();
  if (!raw) throw new Error('Missing fixture adapter');
  raw.requestDevice = async () => {
    throw new DOMException('Device creation cancelled', 'AbortError');
  };
  const adapter = (await requestAdapterFrom({ requestAdapter: async () => raw })).unwrap();
  const result = await adapter.requestDevice();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected native failure');
  expect(result.error.code).toBe('webgpu-runtime-error');
  expect(result.error.detail).toMatchObject({
    error: {
      code: 'request-device-threw',
      name: 'AbortError',
      message: 'Device creation cancelled',
    },
  });
});
