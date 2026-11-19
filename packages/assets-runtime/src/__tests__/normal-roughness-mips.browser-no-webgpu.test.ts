import * as backend from '@forgeax/engine/rhi-wgpu';
import { expect, it } from 'vitest';
import { verifyNormalRoughnessMips } from './normal-roughness-mips.fixture';

it('filters normal variance through legal WebGL2 physical array/mip staging', {
  timeout: 60000,
}, async () => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  try {
    await backend.ensureReady();
    const adapter = (await backend.requestAdapter(undefined, canvas)).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    expect(device.caps.backendKind).toBe('wgpu-webgl2');
    await verifyNormalRoughnessMips(device, backend.createShaderModule);
  } finally {
    canvas.remove();
  }
});
