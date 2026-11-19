import { createShaderModuleImmediate, requestAdapter } from '@forgeax/engine/rhi-webgpu';
import { it } from 'vitest';
import { verifyNormalRoughnessMips } from './normal-roughness-mips.fixture';

it('filters normal variance on GPU without accumulated quantization roughness', {
  timeout: 60000,
}, async () => {
  const adapter = (await requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  await verifyNormalRoughnessMips(device, async (device, descriptor) =>
    createShaderModuleImmediate(device, descriptor),
  );
});
