import * as gpu from '@forgeax/engine/rhi-wgpu';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import {
  verifyBuiltinColorMipFilters,
  verifyWaterImpulseMipChain,
} from './texture-generators.gpu-fixture';

it('publishes authored impulse mips and built-in color reductions through WebGL2 staging', {
  timeout: 60000,
}, async () => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  try {
    await gpu.ensureReady();
    const adapter = (await gpu.requestAdapter(undefined, canvas)).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    expect(device.caps.backendKind).toBe('wgpu-webgl2');
    await verifyBuiltinColorMipFilters(device, gpu.createShaderModule);
    await verifyWaterImpulseMipChain(
      device,
      gpu.createShaderModule,
      await commands.prepareWaterImpulseNoise(),
    );
  } finally {
    canvas.remove();
  }
});
