import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createTsrProgram } from '../tsr/program';

describe('production TSR compute programs', () => {
  it('creates both production pipelines within the portable 16 KiB workgroup budget', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({ requiredLimits: { maxComputeWorkgroupStorageSize: 16384 } })
    ).unwrap();
    expect(device.limits.maxComputeWorkgroupStorageSize).toBe(16384);
    const frame = {
      runtime: {
        device,
        immediateShaderModuleFactory: {
          createShaderModule: (descriptor: { label?: string; code: string }) =>
            createShaderModuleImmediate(device, descriptor),
        },
      },
    } as unknown as RenderPipelineFrame;
    const analysis = createTsrProgram(frame, true);
    const reconstruction = createTsrProgram(frame, false);
    expect(analysis.pipeline).toBeDefined();
    expect(reconstruction.pipeline).toBeDefined();
    expect(analysis.layout).not.toBe(reconstruction.layout);
    await device.queue.onSubmittedWorkDone();
  });
});
