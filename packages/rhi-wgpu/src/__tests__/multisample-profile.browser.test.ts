import { multisampleRenderCapability, probeMultisampleRenderCapability } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { createShaderModuleImmediate, ensureReady, rhi } from '../index';

it('qualifies real WebGL2 HDR four-sample coverage, depth testing and resolve once per device', async () => {
  await ensureReady();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const adapter = (await rhi.requestAdapter(undefined, canvas)).unwrap();
  const device = (
    await adapter.requestDevice({
      requiredFeatures: adapter.features.has('depth32float-stencil8')
        ? ['depth32float-stencil8']
        : [],
    })
  ).unwrap();
  try {
    expect(device.caps.backendKind).toBe('wgpu-webgl2');
    const factory = (descriptor: GPUShaderModuleDescriptor) =>
      createShaderModuleImmediate(device, descriptor);
    const pending = probeMultisampleRenderCapability(device, factory, 9);
    expect(probeMultisampleRenderCapability(device, factory, 9)).toBe(pending);
    const result = await pending;
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    const receipt = result.unwrap();
    expect(receipt).toMatchObject({
      sampleCount: 4,
      colorFormat: 'rgba16float',
      depthFormat: 'depth32float-stencil8',
      evidence: 'real',
      deviceGeneration: 9,
    });
    expect(multisampleRenderCapability(device)).toBe(result);
  } finally {
    if (saved === undefined) Reflect.deleteProperty(navigator, 'gpu');
    else Object.defineProperty(navigator, 'gpu', saved);
    canvas.remove();
  }
});
