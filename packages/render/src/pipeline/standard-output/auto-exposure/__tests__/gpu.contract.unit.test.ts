import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  addAutoExposureExposurePass,
  addAutoExposureGraphPasses,
  createAutoExposureApplyWgsl,
} from '../gpu';

describe('auto exposure GPU pass contract', () => {
  it('encodes clear, histogram, and adapt in one compute pass with a fixed cohort', () => {
    type Descriptor = {
      readonly accesses: readonly unknown[];
      readonly encode: (context: never) => void;
    };
    const passes: Array<{ name: string; kind: string; descriptor: Descriptor }> = [];
    const graph = {
      addComputePass: (name: string, descriptor: Descriptor) => {
        passes.push({ name, kind: 'compute', descriptor });
        return ok(undefined);
      },
    };
    const result = addAutoExposureGraphPasses(
      { graph } as never,
      {
        source: { view: {} },
        resources: { histogram: {}, state: {}, candidate: {}, parameters: {} },
        width: 1080,
        height: 1920,
      } as never,
    );

    expect(result.ok).toBe(true);
    expect(passes.map(({ name, kind }) => [name, kind])).toEqual([
      ['auto-exposure-meter', 'compute'],
    ]);
    expect(passes[0]?.descriptor.accesses).toEqual([
      { resource: {}, usage: 'sampled-read' },
      { resource: {}, usage: 'storage-write' },
      { resource: {}, usage: 'storage-write' },
      { resource: {}, usage: 'storage-write' },
      { resource: {}, usage: 'storage-read' },
    ]);

    const pipelineNames: string[] = [];
    const setPipeline = vi.fn((pipeline: { readonly label: string }) => {
      pipelineNames.push(pipeline.label);
    });
    const setBindGroup = vi.fn();
    const dispatchWorkgroups = vi.fn();
    const shaderFactory = {
      createShaderModule: vi.fn(({ label }: { readonly label: string }) => ok({ label })),
    };
    const device = {
      createBindGroupLayout: vi.fn((descriptor: unknown) => ok({ descriptor })),
      createPipelineLayout: vi.fn((descriptor: unknown) => ok({ descriptor })),
      createComputePipeline: vi.fn((descriptor: { readonly label: string }) =>
        ok({ label: descriptor.label }),
      ),
      createBindGroup: vi.fn((descriptor: unknown) => ok({ descriptor })),
    };
    const encoded = passes[0]?.descriptor.encode({
      pass: { setPipeline, setBindGroup, dispatchWorkgroups },
      frame: { runtime: { device, immediateShaderModuleFactory: shaderFactory } },
      resources: {
        textureView: () => ok({}),
        buffer: () => ok({}),
      },
    } as never);

    expect(encoded).toBeUndefined();
    expect(pipelineNames).toEqual([
      'auto_exposure_clear',
      'auto_exposure_histogram',
      'auto_exposure_adapt',
    ]);
    expect(dispatchWorkgroups).toHaveBeenCalledTimes(3);
    expect(dispatchWorkgroups).toHaveBeenNthCalledWith(1, 1, 1, 1);
    expect(dispatchWorkgroups).toHaveBeenNthCalledWith(2, 4, 8, 1);
    expect(dispatchWorkgroups).toHaveBeenNthCalledWith(3, 1, 1, 1);
    expect(setBindGroup).toHaveBeenCalledTimes(1);
    expect(device.createComputePipeline).toHaveBeenCalledTimes(3);
  });

  it('routes the same-frame GPU candidate into the exposure consumer', () => {
    const passes: Array<{ name: string; descriptor: { accesses: readonly unknown[] } }> = [];
    const graph = {
      addRasterPass: (name: string, descriptor: { accesses: readonly unknown[] }) => {
        passes.push({ name, descriptor });
        return ok(undefined);
      },
    };
    const result = addAutoExposureExposurePass(
      { graph } as never,
      { view: {}, format: 'rgba16float' } as never,
      { view: {}, format: 'rgba16float' } as never,
      { histogram: {}, state: {}, candidate: {}, parameters: {} } as never,
    );
    expect(result.ok).toBe(true);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({
      name: 'standard-exposure-white-balance',
      descriptor: {
        accesses: [
          { resource: {}, usage: 'sampled-read' },
          { resource: {}, usage: 'storage-read' },
          { resource: {}, usage: 'color-attachment' },
        ],
      },
    });
  });

  it('keeps Bradford white balance in the sole linear-HDR consumer and preserves alpha', () => {
    const withCandidate = createAutoExposureApplyWgsl({ temperature: 5000, tint: 0.2 }, true);
    expect(withCandidate).toContain('@group(1) @binding(0) var<storage, read> candidate');
    expect(withCandidate).toContain('mul_bradford');
    expect(withCandidate).toContain('blackbody_white_point');
    expect(withCandidate).toContain('WB_TEMPERATURE: f32 = 5000.00000000');
    expect(withCandidate).toContain('WB_TINT: f32 = 0.20000000');
    expect(withCandidate).toContain('color.a');

    const manual = createAutoExposureApplyWgsl({ temperature: 6504, tint: 0 }, false);
    expect(manual).not.toContain('var<storage, read> candidate');
    expect(manual).toContain('let exposed = color.rgb * 1.0');
  });
});
