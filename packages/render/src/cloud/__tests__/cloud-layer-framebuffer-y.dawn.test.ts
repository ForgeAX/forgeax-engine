import { expect, it } from 'vitest';
import { readCloudComposition } from './cloud-mode0-kernels.fixture';

it('keeps asymmetric color rows and foreground rejection in framebuffer top-left order', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  try {
    const noCloud = await readCloudComposition(device);
    expect([0, 1, 2, 3].map((y) => Math.round((noCloud[y * 16] ?? NaN) * 255))).toEqual([
      20, 80, 140, 200,
    ]);
    expect(Math.round((noCloud[40] ?? NaN) * 255)).toBe(140);
    const near = await readCloudComposition(device, {
      transport: [0.25, 0, 0, 0.5],
      sceneMeters: 10,
    });
    const far = await readCloudComposition(device, {
      transport: [0.25, 0, 0, 0.5],
      sceneMeters: 10000,
    });
    expect(Array.from(near)).toEqual(Array.from(noCloud));
    expect(Math.abs((near[40] ?? NaN) - (far[40] ?? NaN)) * 255).toBeGreaterThan(2);
  } finally {
    device.destroy();
  }
});
