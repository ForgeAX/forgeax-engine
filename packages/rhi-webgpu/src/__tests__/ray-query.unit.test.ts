import { BLAS_INPUT_BUFFER_USAGE, RAY_QUERY_WGSL_ENABLE, type Tlas } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { makeRhiDevice } from '../device';
import { createShaderModuleImmediate, requestDevice } from '../index';
import { createMockGpu } from './__mocks__/gpu-device';

function code(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('rhi-webgpu Ray Query capability', () => {
  it('reports backend-has-no-ray-query and refuses acceleration structures before reaching GPUDevice', async () => {
    const gpu = createMockGpu();
    const device = (await requestDevice({ gpu })).unwrap();
    expect(device.caps.rayQuery).toEqual({ supported: false, reason: 'backend-has-no-ray-query' });
    expect(
      code(device.createBlas({ geometries: [{ vertexFormat: 'float32x3', vertexCount: 3 }] })),
    ).toBe('feature-not-enabled');
    expect(code(device.createTlas({ maxInstances: 1 }))).toBe('feature-not-enabled');
    expect(code(device.createBuffer({ size: 36, usage: BLAS_INPUT_BUFFER_USAGE | 0x8 }))).toBe(
      'feature-not-enabled',
    );
    expect(code(device.destroyTlas({} as Tlas))).toBe('feature-not-enabled');
    expect(code(device.createCommandEncoder().unwrap().buildAccelerationStructures([], []))).toBe(
      'feature-not-enabled',
    );
    expect(
      code(
        device.createBindGroupLayout({
          entries: [{ binding: 0, visibility: 4, accelerationStructure: {} }],
        }),
      ),
    ).toBe('feature-not-enabled');
  });

  it('refuses Ray Query WGSL and admits ordinary WGSL', async () => {
    const gpu = createMockGpu();
    const device = (await requestDevice({ gpu })).unwrap();
    const refused = createShaderModuleImmediate(device, {
      code: `${RAY_QUERY_WGSL_ENABLE}\n@compute @workgroup_size(1) fn main() {}`,
    });
    expect(code(refused)).toBe('feature-not-enabled');
    expect(
      createShaderModuleImmediate(device, { code: '@compute @workgroup_size(1) fn main() {}' }).ok,
    ).toBe(true);
  });
});

describe('rhi-webgpu timestamp period', () => {
  async function rawDevice(extra: Record<string, unknown>): Promise<GPUDevice> {
    const adapter = await createMockGpu().requestAdapter();
    if (adapter === null) throw new Error('mock adapter');
    const raw = await adapter.requestDevice();
    Object.assign(raw, { features: new Set(['timestamp-query']), ...extra });
    return raw as unknown as GPUDevice;
  }

  it('publishes nanoseconds for W3C devices and the native tick period when exposed', async () => {
    expect(makeRhiDevice(await rawDevice({})).device.caps.timestampPeriodNanoseconds).toBe(1);
    expect(
      makeRhiDevice(await rawDevice({ timestampPeriod: 41.666 })).device.caps
        .timestampPeriodNanoseconds,
    ).toBe(41.666);
  });
});

// Structural shim evidence for the native extension, separate from Dawn/browser
// capability refusals and from physical native-wgpu shader execution.
describe('native Ray Query extension lifecycle through RHI', () => {
  it('commits build admission only after the raw call succeeds and refuses retired or foreign handles', async () => {
    const adapter = await createMockGpu().requestAdapter();
    if (adapter === null) throw new Error('mock adapter');
    const raw = await adapter.requestDevice();
    const destroy = vi.fn();
    const nativeBuild = vi.fn();
    const createEncoder = raw.createCommandEncoder.bind(raw);
    Object.assign(raw.limits, {
      maxBlasGeometryCount: 4,
      maxBlasPrimitiveCount: 1024,
      maxTlasInstanceCount: 16,
      maxAccelerationStructuresPerShaderStage: 1,
    });
    Object.assign(raw, {
      features: new Set(['wgpu-ray-query']),
      createBlas: () => ({ destroy }),
      createTlas: () => ({ destroy }),
      createCommandEncoder: () =>
        Object.assign(createEncoder(), {
          buildAccelerationStructures: nativeBuild,
        }),
    });
    const device = makeRhiDevice(raw as unknown as GPUDevice).device;
    const foreign = makeRhiDevice(raw as unknown as GPUDevice).device;
    expect(device.caps.rayQuery.supported).toBe(true);
    const vertices = device.createBuffer({ size: 36, usage: BLAS_INPUT_BUFFER_USAGE }).unwrap();
    const blas = device
      .createBlas({ geometries: [{ vertexFormat: 'float32x3', vertexCount: 3 }] })
      .unwrap();
    const tlas = device.createTlas({ maxInstances: 1 }).unwrap();
    const geometry = { blas, geometries: [{ vertexBuffer: vertices, vertexStride: 12 }] };
    const placement = {
      tlas,
      instances: [
        { blas, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], customIndex: 0, mask: 255 },
      ],
    };
    const encoder = device.createCommandEncoder().unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 4, accelerationStructure: {} }],
      })
      .unwrap();
    const bind = () =>
      device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { kind: 'accelerationStructure', value: tlas } }],
      });

    expect(code(encoder.buildAccelerationStructures([], [placement]))).toBe(
      'rhi-descriptor-invalid',
    );
    expect(nativeBuild).not.toHaveBeenCalled();
    expect(code(bind())).toBe('rhi-descriptor-invalid');
    nativeBuild.mockImplementationOnce(() => {
      throw new Error('native build refused');
    });
    expect(() => encoder.buildAccelerationStructures([geometry], [placement])).toThrow(
      'native build refused',
    );
    expect(code(bind())).toBe('rhi-descriptor-invalid');
    expect(code(encoder.buildAccelerationStructures([], [placement]))).toBe(
      'rhi-descriptor-invalid',
    );
    encoder.buildAccelerationStructures([geometry], [placement]).unwrap();
    expect(bind().ok).toBe(true);
    expect(nativeBuild).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          blas,
          geometries: [expect.objectContaining({ vertexStride: 12 })],
        }),
      ],
      [placement],
    );
    encoder.buildAccelerationStructures([], [placement]).unwrap();
    expect(
      code(foreign.createCommandEncoder().unwrap().buildAccelerationStructures([], [placement])),
    ).toBe('destroy-after-destroy');
    device.destroyBlas(blas).unwrap();
    expect(code(encoder.buildAccelerationStructures([], [placement]))).toBe(
      'destroy-after-destroy',
    );
    device.destroyTlas(tlas).unwrap();
    expect(code(bind())).toBe('rhi-descriptor-invalid');
    expect(code(device.destroyTlas(tlas))).toBe('destroy-after-destroy');
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
