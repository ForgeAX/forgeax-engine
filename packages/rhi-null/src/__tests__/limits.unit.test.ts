import { expect, it } from 'vitest';
import { RhiNullAdapter } from '../adapter';

it('reports the WebGPU guaranteed binding limits advertised by its storage-buffer capability', async () => {
  const adapter = new RhiNullAdapter();
  const device = (await adapter.requestDevice()).unwrap();
  const minimums = {
    maxBindingsPerBindGroup: 1000,
    maxStorageBuffersPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12,
    maxSampledTexturesPerShaderStage: 16,
  } as const;

  expect(device.caps.storageBuffer).toBe(true);
  for (const [name, minimum] of Object.entries(minimums)) {
    expect(
      adapter.limits[name as keyof typeof minimums],
      `${name} adapter limit`,
    ).toBeGreaterThanOrEqual(minimum);
    expect(
      device.limits[name as keyof typeof minimums],
      `${name} device limit`,
    ).toBeGreaterThanOrEqual(minimum);
  }
});
