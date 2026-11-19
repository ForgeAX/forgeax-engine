import * as gpu from '@forgeax/engine/rhi-wgpu';
import { expect, it } from 'vitest';
import { verifyPlanarMipChain } from './planar-mip-passes.gpu-fixture';

it.each([
  'rgba8unorm',
  'rgba8unorm-srgb',
] as const)('retains legal real WebGL2 planar mip filtering (%s)', {
  timeout: 60000,
}, async (format) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  document.body.append(canvas);
  await gpu.ensureReady();
  const device = (
    await (await gpu.requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  try {
    expect(device.caps.backendKind).toBe('wgpu-webgl2');
    await verifyPlanarMipChain(device, gpu.createShaderModule, format, 8, 8);
    await verifyPlanarMipChain(device, gpu.createShaderModule, format, 17, 5);
  } finally {
    canvas.remove();
  }
});
