import { expect, it } from 'vitest';
import { readCloudComposition } from './cloud-mode0-kernels.fixture';

it('reads production cloud composition and foreground exclusion on a live browser device', async () => {
  expect(navigator.gpu).toBeDefined();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Browser GPU unavailable');
  const device = await adapter.requestDevice();
  try {
    const noCloud = await readCloudComposition(device);
    expect([0, 1, 2, 3].map((y) => Math.round((noCloud[y * 16] ?? NaN) * 255))).toEqual([
      20, 80, 140, 200,
    ]);
    expect(Math.round((noCloud[40] ?? NaN) * 255)).toBe(140);
    const foreground = await readCloudComposition(device, {
      transport: [1, 0, 0, 0.5],
      sceneMeters: 10,
      cloudMeters: 2000,
    });
    expect(Array.from(foreground)).toEqual(Array.from(noCloud));
    const visible = await readCloudComposition(device, {
      transport: [1, 0, 0, 0.5],
      sceneMeters: 10000,
      cloudMeters: 2000,
    });
    expect(visible[40]).toBeCloseTo(1 + (140 / 255) * 0.5, 6);
    expect(visible[43]).toBe(1);
  } finally {
    device.destroy();
  }
});
