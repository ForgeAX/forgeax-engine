import { it } from 'vitest';
import { verifyWgpuTextureReadback } from './texture-readback-staging.fixture';

for (const format of ['rgba8unorm', 'rgba16float'] as const) {
  it.each([
    '2d',
    'cube',
  ] as const)(`retains every %s ${format} face/mip in WebGL2 shared staging`, async (dimension) => {
    await verifyWgpuTextureReadback(format, dimension, 'wgpu-webgl2');
  });
}
