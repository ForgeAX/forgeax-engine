import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import {
  BARREL_DISTORTION_POST_PROCESS_ID,
  BARREL_DISTORTION_WGSL,
} from '../features/barrel-distortion';

describe('barrel distortion production shader on Dawn', () => {
  it('compiles both production entries and creates the linear-LDR pipeline', async () => {
    const adapter = await rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const deviceResult = await adapter.value.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const device: RhiDevice = deviceResult.value;

    const shader = await createShaderModule(device, {
      label: BARREL_DISTORTION_POST_PROCESS_ID,
      code: BARREL_DISTORTION_WGSL,
    });
    expect(shader.ok).toBe(true);
    if (!shader.ok) return;

    const pipeline = device.createRenderPipeline({
      label: BARREL_DISTORTION_POST_PROCESS_ID,
      layout: 'auto',
      vertex: { module: shader.value, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module: shader.value,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: undefined,
      multisample: undefined,
    });
    expect(pipeline.ok).toBe(true);
  });
});
