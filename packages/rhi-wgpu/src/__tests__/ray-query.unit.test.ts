import { BLAS_INPUT_BUFFER_USAGE, RAY_QUERY_WGSL_ENABLE, type Tlas } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { makeRhiDevice, type RawDeviceLike } from '../device';
import { createShaderModuleImmediate } from '../index';

function code(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function rawDevice(): RawDeviceLike {
  const noop = (): unknown => ({});
  return {
    features: new Set<string>(),
    limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 },
    createTexture: noop,
    createSampler: noop,
    createBindGroupLayout: noop,
    createBindGroup: noop,
    createPipelineLayout: noop,
    createRenderPipeline: noop,
    createComputePipeline: noop,
    createShaderModule: noop,
    createCommandEncoder: noop,
    queue: {
      submit() {},
      writeBuffer() {},
      writeTexture() {},
      copyExternalImageToTexture() {},
      onSubmittedWorkDone: async () => undefined,
    },
  } as unknown as RawDeviceLike;
}

describe('rhi-wgpu Ray Query capability', () => {
  it('reports backend-has-no-ray-query and refuses acceleration structures', () => {
    const { device } = makeRhiDevice(rawDevice());
    expect(device.caps.rayQuery).toEqual({ supported: false, reason: 'backend-has-no-ray-query' });
    expect(
      code(device.createBlas({ geometries: [{ vertexFormat: 'float32x3', vertexCount: 3 }] })),
    ).toBe('feature-not-enabled');
    expect(code(device.createTlas({ maxInstances: 1 }))).toBe('feature-not-enabled');
    expect(code(device.createBuffer({ size: 36, usage: BLAS_INPUT_BUFFER_USAGE | 0x8 }))).toBe(
      'feature-not-enabled',
    );
    expect(code(device.destroyTlas({} as Tlas))).toBe('feature-not-enabled');
    expect(
      code(
        device.createBindGroupLayout({
          entries: [{ binding: 0, visibility: 4, accelerationStructure: {} }],
        }),
      ),
    ).toBe('feature-not-enabled');
    expect(code(device.createCommandEncoder().unwrap().buildAccelerationStructures([], []))).toBe(
      'feature-not-enabled',
    );
  });

  it('refuses Ray Query WGSL before it reaches the wasm compiler', () => {
    const { device } = makeRhiDevice(rawDevice());
    const refused = createShaderModuleImmediate(device, {
      code: `${RAY_QUERY_WGSL_ENABLE}\n@compute @workgroup_size(1) fn main() {}`,
    });
    expect(code(refused)).toBe('feature-not-enabled');
  });
});
