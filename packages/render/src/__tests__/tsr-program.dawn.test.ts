import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createTsrProgram, type TsrStage } from '../tsr/program';
import { nativeDeviceFixture } from './native-device-fixture';

const PRODUCTION_COMPUTE_STAGES: readonly TsrStage[] = [
  'dilate',
  'analyze',
  'resurrectGuide',
  'moire',
  'rejectFused',
  'spatial',
  'reconstruct',
  'resolve',
];

describe('production TSR compute programs', () => {
  it('creates all production compute pipelines within the portable 16 KiB workgroup budget', async () => {
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
    const built = PRODUCTION_COMPUTE_STAGES.map((stage) => createTsrProgram(frame, stage));
    for (const program of built) expect(program.pipeline).toBeDefined();
    expect(built[1]?.layout).not.toBe(built[6]?.layout);
    await device.queue.onSubmittedWorkDone();
    expect(await native.popErrorScope()).toBeNull();
  });
});
