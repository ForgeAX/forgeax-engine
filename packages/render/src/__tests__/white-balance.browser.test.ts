import { it } from 'vitest';
import { captureWhiteBalance, verifyWhiteBalance } from './white-balance.gpu-fixture';

it('preserves linear sRGB white balance through Browser WebGPU and RHI replay', async () => {
  verifyWhiteBalance(await captureWhiteBalance());
});
