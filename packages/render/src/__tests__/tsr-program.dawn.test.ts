import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createTsrProgram } from '../tsr/program';
import { nativeDeviceFixture } from './native-device-fixture';

describe('production TSR compute programs', () => {
  it('creates both production pipelines within the portable 16 KiB workgroup budget', async () => {
    const { device, native } = await nativeDeviceFixture({
      requiredLimits: { maxComputeWorkgroupStorageSize: 16384 },
    });
    native.pushErrorScope('validation');
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
    expect(await native.popErrorScope()).toBeNull();
  });
});
