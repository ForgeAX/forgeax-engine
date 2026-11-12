import { expect, it } from 'vitest';
import { makeRhiDevice } from '../device';
import { createMockGpu } from './__mocks__/gpu-device';

it.each([
  [{}, true],
  [{ maxStorageBuffersInVertexStage: 0 }, false],
  [{ maxStorageBuffersInFragmentStage: 0 }, false],
  [{ maxStorageBuffersInVertexStage: 2, maxStorageBuffersInFragmentStage: 2 }, true],
] as const)('admits graphics storage from actual per-stage limits %j', async (limits, admitted) => {
  const adapter = await createMockGpu().requestAdapter();
  if (adapter === null) throw new Error('Missing fixture adapter');
  const raw = await adapter.requestDevice();
  Object.assign(raw.limits, limits);
  expect(makeRhiDevice(raw as unknown as GPUDevice).device.caps.storageBuffer).toBe(admitted);
});
