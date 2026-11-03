import { it } from 'vitest';
import { verifyWgpuTextureReadback } from './texture-readback-staging.fixture';

for (const format of ['rgba8unorm', 'rgba16float'] as const) {
  it.each([
    '2d',
    'cube',
  ] as const)(`reads every %s ${format} face/mip through the real RHI snapshot path`, async (dimension) => {
    await verifyWgpuTextureReadback(format, dimension);
  });
}
