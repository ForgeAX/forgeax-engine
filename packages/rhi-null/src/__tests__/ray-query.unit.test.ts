import type {
  BlasBuildEntry,
  BlasDescriptor,
  RhiDevice,
  RhiRayQueryLimits,
  TlasBuildEntry,
} from '@forgeax/engine-rhi';
import { BLAS_INPUT_BUFFER_USAGE } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { RhiNullAdapter } from '../adapter';

const LIMITS: RhiRayQueryLimits = {
  maxBlasGeometryCount: 4,
  maxBlasPrimitiveCount: 1024,
  maxTlasInstanceCount: 16,
  maxAccelerationStructuresPerShaderStage: 1,
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const TRIANGLE: BlasDescriptor = { geometries: [{ vertexFormat: 'float32x3', vertexCount: 3 }] };

async function device(rayQuery?: RhiRayQueryLimits): Promise<RhiDevice> {
  const adapter = new RhiNullAdapter(rayQuery === undefined ? {} : { rayQuery });
  return (await adapter.requestDevice()).unwrap();
}

function code(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function build(d: RhiDevice, blas: readonly BlasBuildEntry[], tlas: readonly TlasBuildEntry[]) {
  return d.createCommandEncoder().unwrap().buildAccelerationStructures(blas, tlas);
}

describe('RhiNull Ray Query', () => {
  it('reports backend-has-no-ray-query by default and refuses every operation', async () => {
    const d = await device();
    expect(d.caps.rayQuery).toEqual({ supported: false, reason: 'backend-has-no-ray-query' });
    expect(code(d.createBlas(TRIANGLE))).toBe('feature-not-enabled');
    expect(code(d.createTlas({ maxInstances: 1 }))).toBe('feature-not-enabled');
    expect(code(build(d, [], []))).toBe('feature-not-enabled');
    expect(code(d.createBuffer({ size: 36, usage: BLAS_INPUT_BUFFER_USAGE }))).toBe(
      'feature-not-enabled',
    );
    expect(d.createBuffer({ size: 36, usage: 0x28 }).ok).toBe(true);
    expect(
      code(
        d.createBindGroupLayout({
          entries: [{ binding: 0, visibility: 4, accelerationStructure: {} }],
        }),
      ),
    ).toBe('feature-not-enabled');
  });

  it('simulates a Ray Query device with BLAS-before-TLAS build ordering', async () => {
    const d = await device(LIMITS);
    expect(d.caps.rayQuery).toEqual({ supported: true, ...LIMITS });
    const vertices = d.createBuffer({ size: 36, usage: BLAS_INPUT_BUFFER_USAGE | 0x8 }).unwrap();
    const blas = d.createBlas(TRIANGLE).unwrap();
    const tlas = d.createTlas({ maxInstances: 2 }).unwrap();
    const instance = { blas, transform: IDENTITY, customIndex: 1, mask: 0xff };
    const blasEntry = { blas, geometries: [{ vertexBuffer: vertices, vertexStride: 12 }] };

    expect(code(build(d, [], [{ tlas, instances: [instance] }]))).toBe('rhi-descriptor-invalid');
    expect(build(d, [blasEntry], [{ tlas, instances: [instance] }]).ok).toBe(true);
    expect(build(d, [], [{ tlas, instances: [instance, instance] }]).ok).toBe(true);
    expect(code(build(d, [], [{ tlas, instances: [instance, instance, instance] }]))).toBe(
      'rhi-descriptor-invalid',
    );
  });

  it('requires BLAS_INPUT_BUFFER_USAGE on BLAS geometry buffers', async () => {
    const d = await device(LIMITS);
    const vertex = d.createBuffer({ size: 36, usage: 0x28 }).unwrap();
    const blas = d.createBlas(TRIANGLE).unwrap();
    expect(
      code(build(d, [{ blas, geometries: [{ vertexBuffer: vertex, vertexStride: 12 }] }], [])),
    ).toBe('rhi-descriptor-invalid');
  });

  it('admits a TLAS binding only once built and live', async () => {
    const d = await device(LIMITS);
    const layout = d
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 4, accelerationStructure: {} }],
      })
      .unwrap();
    const vertices = d.createBuffer({ size: 36, usage: BLAS_INPUT_BUFFER_USAGE | 0x8 }).unwrap();
    const blas = d.createBlas(TRIANGLE).unwrap();
    const tlas = d.createTlas({ maxInstances: 1 }).unwrap();
    const bind = () =>
      d.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { kind: 'accelerationStructure', value: tlas } }],
      });

    expect(code(bind())).toBe('rhi-descriptor-invalid');
    build(
      d,
      [{ blas, geometries: [{ vertexBuffer: vertices, vertexStride: 12 }] }],
      [{ tlas, instances: [{ blas, transform: IDENTITY, customIndex: 0, mask: 1 }] }],
    ).unwrap();
    expect(bind().ok).toBe(true);
    expect(d.destroyTlas(tlas).ok).toBe(true);
    expect(code(bind())).toBe('rhi-descriptor-invalid');
    expect(code(d.destroyTlas(tlas))).toBe('destroy-after-destroy');
  });

  it('refuses destroyed BLAS instances and foreign-device handles', async () => {
    const d = await device(LIMITS);
    const other = await device(LIMITS);
    const vertices = d.createBuffer({ size: 36, usage: BLAS_INPUT_BUFFER_USAGE | 0x8 }).unwrap();
    const blas = d.createBlas(TRIANGLE).unwrap();
    const tlas = d.createTlas({ maxInstances: 1 }).unwrap();
    build(d, [{ blas, geometries: [{ vertexBuffer: vertices, vertexStride: 12 }] }], []).unwrap();
    d.destroyBlas(blas).unwrap();
    expect(
      code(
        build(
          d,
          [],
          [{ tlas, instances: [{ blas, transform: IDENTITY, customIndex: 0, mask: 1 }] }],
        ),
      ),
    ).toBe('destroy-after-destroy');
    expect(code(build(other, [], [{ tlas, instances: [] }]))).toBe('rhi-not-available');
  });
});
