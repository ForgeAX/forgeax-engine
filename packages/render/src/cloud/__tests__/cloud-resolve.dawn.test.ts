import { expect, it } from 'vitest';
import { readCloudComposition } from './cloud-mode0-kernels.fixture';

it('preserves scene coverage while independently composing cloud radiance and transmittance', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  try {
    for (const opacity of [0.5, 1])
      for (const t of [0, 0.5, 1]) {
        const actual = await readCloudComposition(device, {
          width: 1,
          height: 1,
          transport: [0.25, 0.25, 0.25, t],
          opacity,
        });
        expect(actual[3]).toBe(opacity);
        expect(actual[0]).toBeCloseTo((20 / 255) * t + 0.25, 6);
        expect(actual[1]).toBeCloseTo((7 / 255) * t + 0.25, 6);
        expect(actual[2]).toBeCloseTo((240 / 255) * t + 0.25, 6);
      }
  } finally {
    device.destroy();
  }
});
